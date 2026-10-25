/**
 * Activating an app, and following the versions it runs.
 *
 * The CLI uploads an app's Worker, marks its row `binding` and redeploys
 * the gateway with a service binding to it. The first request that reaches
 * the app on a gateway version holding that binding makes it `active`
 * (ADR-0003). An isolate still on the previous version has no such binding
 * and keeps answering "deploying", which is exactly the rollout window.
 *
 * Self-hosted and hosted gateways activate apps on their own (both reach
 * their apps over service bindings: platformPolicy's bindingActivation);
 * an invalid `GATEWAY_DEPLOYMENT_MODE` (unset included) leaves them
 * deploying.
 *
 * Activation also takes the app's tool snapshot, after the response: the
 * CLI's deploy waits for the app to go live, so the catalog is there before
 * anyone opens the consent page or calls /mcp. A redeploy of an active app
 * on self-host records its new `apps.version_id` straight in D1 and tells
 * the gateway nothing, so each isolate follows the version from the app
 * host's requests ({@link followAppVersion}): the deploy's own live wait
 * is the first of them.
 *
 * Behind Cloudflare Access the deploy's own probe never reaches the
 * gateway, so nobody makes that first request until a person opens the
 * app. Two more triggers make the same probe and the same transition: the
 * launcher and Admin → Apps read their lists through
 * {@link activateBindingApps}, and the per-minute cron sweeps every
 * `binding` row of the install through {@link activateDeployingApps}, so
 * an uploaded app is live within a minute whether or not anyone visits,
 * and the CLI's live wait (which reads D1) finishes under Access too.
 * "Deploying" then means the gateway can't reach the Worker yet, not that
 * nobody has visited. One `app.live` event records the transition, with
 * which trigger made it.
 */
import { waitUntil } from "cloudflare:workers";
import {
  getAppFetcher,
  logEvent,
  type AppRegistry,
  type RegisteredApp,
} from "@every-app/perimeter";
import { emit } from "@/server/events/bus";
import { catalogue, type AppLiveTrigger } from "@/server/events/catalogue";
import { GATEWAY_ACTOR } from "@/server/events/subjects";
import { AppRepository } from "@/server/repositories/AppRepository";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { platformPolicy } from "@/server/platform-policy";
import {
  scheduleCatalogResync,
  type SyncableApp,
} from "@/server/toolbus/catalog-sync";

/** A resolved app as a sync takes it; null for one without a row id. */
function syncTarget(app: RegisteredApp): SyncableApp | null {
  if (!app.rowId) return null;
  return {
    rowId: app.rowId,
    organizationId: app.organizationId,
    appSlug: app.appId,
    hostname: app.hostname,
    workerName: app.workerName,
    tier: app.tier,
    versionId: app.versionId ?? null,
  };
}

/**
 * Whether this gateway version can reach an app's Worker through the one
 * seam (its service binding, or the dispatch namespace), and a request
 * through it gets any HTTP response.
 */
export async function probeApp(
  env: object,
  app: RegisteredApp,
): Promise<boolean> {
  try {
    await getAppFetcher(env as Record<string, unknown>, app).fetch(
      new Request(`https://${app.hostname}/__everyapp/health`),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Make a `binding` app `active` once this isolate reaches its Worker. True
 * when the app is now active and the request may be served. The isolate
 * that makes the transition announces it once (`app.live`, with the
 * trigger); one that finds another got there first says nothing.
 */
export async function activateApp(
  env: { GATEWAY_DEPLOYMENT_MODE?: string },
  app: RegisteredApp,
  trigger: AppLiveTrigger = "request",
): Promise<boolean> {
  if (!platformPolicy(env).bindingActivation) return false;
  if (!app.rowId || !(await probeApp(env, app))) return false;
  const result = await AppRepository.activate(app.rowId, app.organizationId);
  if (!result) {
    // Deleted or disabled since the request looked it up.
    return false;
  }
  if (result.activated) {
    logEvent("app.activated", {
      app: app.appId,
      org: app.organizationId,
      trigger,
    });
    await emit({
      organizationId: app.organizationId,
      actor: GATEWAY_ACTOR,
      ...catalogue.appLive({
        app: { id: app.appId, rowId: app.rowId, name: result.name },
        version: app.versionId ?? null,
        trigger,
      }),
    });
  }
  const target = syncTarget(app);
  if (target) scheduleCatalogResync(target, "first_use");
  return true;
}

/** How many `binding` apps one list read probes; a list seldom has any. */
const LIST_ACTIVATIONS_MAX = 5;

/** How a list of apps is read, for {@link activateBindingApps}. */
interface BindingActivationOptions {
  /** What `app.live` and the logs say made it live; a list by default. */
  trigger?: AppLiveTrigger;
  /** How many of the list's `binding` apps are probed, at most. */
  max?: number;
}

/** What a listed row needs to say for {@link activateBindingApps} to look it up. */
interface ListedAppRow {
  id: string;
  organizationId: string;
  appId: string;
  status: string;
}

/**
 * Make the `binding` apps of a list live when this gateway reaches their
 * Workers: the row ids now active, for the list to show as such. The same
 * probe and transition as a request on the app's host, so a person
 * reading the launcher completes a deploy that Cloudflare Access kept the
 * CLI's own probe from completing. At most a few probes per read, one per
 * app, nothing thrown: an app this gateway can't reach yet stays as
 * listed, for the next read (the launcher polls while one is deploying).
 */
export async function activateBindingApps(
  env: { GATEWAY_DEPLOYMENT_MODE?: string },
  /** Opened only when the list has a `binding` app, inside its guard. */
  openRegistry: () => Pick<AppRegistry, "findByOrgApp">,
  listed: readonly ListedAppRow[],
  {
    trigger = "list",
    max = LIST_ACTIVATIONS_MAX,
  }: BindingActivationOptions = {},
): Promise<Set<string>> {
  const activated = new Set<string>();
  const binding = listed
    .filter((app) => app.status === "binding")
    .slice(0, max);
  if (binding.length === 0) return activated;
  let registry: Pick<AppRegistry, "findByOrgApp">;
  try {
    registry = openRegistry();
  } catch (error) {
    logEvent(
      "app.activate_failed",
      {
        trigger,
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return activated;
  }
  await Promise.all(
    binding.map(async (row) => {
      try {
        const app = await registry.findByOrgApp(row.organizationId, row.appId);
        if (!app || app.status !== "binding") return;
        if (await activateApp(env, app, trigger)) activated.add(row.id);
      } catch (error) {
        logEvent(
          "app.activate_failed",
          {
            app: row.appId,
            trigger,
            message: error instanceof Error ? error.message : String(error),
          },
          "warn",
        );
      }
    }),
  );
  return activated;
}

/** How many `binding` apps one scheduled sweep probes: a whole install's, in practice. */
const SCHEDULED_ACTIVATIONS_MAX = 50;

/**
 * The cron's sweep (server.ts `scheduled`, every minute): every `binding`
 * row of the install, probed and made active like a visit would. This is
 * what finishes a deploy behind Cloudflare Access, where neither the
 * CLI's probe nor an uptime monitor reaches the gateway: the CLI's live
 * wait reads the row and sees it go `active` within a minute. Bounded,
 * never throws (a sweep that fails is logged as `app.activate_failed`,
 * trigger `scheduled`, and the next minute tries again). How many went
 * live.
 */
export async function activateDeployingApps(
  env: { GATEWAY_DEPLOYMENT_MODE?: string },
  openRegistry: () => Pick<AppRegistry, "findByOrgApp">,
): Promise<number> {
  if (!platformPolicy(env).bindingActivation) return 0;
  let binding: ListedAppRow[];
  try {
    binding = await AppRepository.findBinding(SCHEDULED_ACTIVATIONS_MAX);
  } catch (error) {
    logEvent(
      "app.activate_failed",
      {
        trigger: "scheduled",
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
    return 0;
  }
  if (binding.length === 0) return 0;
  const activated = await activateBindingApps(env, openRegistry, binding, {
    trigger: "scheduled",
    max: SCHEDULED_ACTIVATIONS_MAX,
  });
  if (activated.size > 0) {
    logEvent("app.activate_sweep", {
      binding: binding.length,
      activated: activated.size,
    });
  }
  return activated.size;
}

// Per isolate: the version of each app this isolate last checked the
// snapshot against, so a request costs one lookup until the app redeploys.
const CHECKED_VERSIONS_MAX_ENTRIES = 500;
const checkedVersions = new Map<string, string>();

/**
 * Follow the version an active app runs: the first request on this isolate
 * that sees a version it hasn't checked reads the snapshot after the
 * response and, when there is none or it was taken from another version,
 * syncs the new one. One D1 read per app per isolate per version; a sync
 * claims the row and version, so a drift sync moments ago doesn't suppress
 * it. Nothing is thrown: a check that fails is logged and tried again on
 * the next version.
 */
export function followAppVersion(app: RegisteredApp): void {
  const target = syncTarget(app);
  if (!target || !target.versionId || app.status !== "active") return;
  const { rowId, versionId } = target;
  if (checkedVersions.get(rowId) === versionId) return;
  checkedVersions.delete(rowId);
  checkedVersions.set(rowId, versionId);
  if (checkedVersions.size > CHECKED_VERSIONS_MAX_ENTRIES) {
    const oldest = checkedVersions.keys().next().value;
    if (oldest !== undefined) checkedVersions.delete(oldest);
  }
  waitUntil(syncIfOtherVersion(target));
}

async function syncIfOtherVersion(target: SyncableApp): Promise<void> {
  try {
    const stored = await AppToolRepository.findByOrgApp(
      target.organizationId,
      target.appSlug,
    );
    if (stored && stored.versionId === target.versionId) return;
    scheduleCatalogResync(target, "new_version");
  } catch (error) {
    logEvent(
      "mcp.catalog.sync_failed",
      {
        app: target.appSlug,
        trigger: "new_version",
        message: error instanceof Error ? error.message : String(error),
      },
      "warn",
    );
  }
}
