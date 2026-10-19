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
 */
import { waitUntil } from "cloudflare:workers";
import {
  getAppFetcher,
  logEvent,
  type RegisteredApp,
} from "@every-app/perimeter";
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
 * when the app is now active and the request may be served.
 */
export async function activateApp(
  env: { GATEWAY_DEPLOYMENT_MODE?: string },
  app: RegisteredApp,
): Promise<boolean> {
  if (!platformPolicy(env).bindingActivation) return false;
  if (!app.rowId || !(await probeApp(env, app))) return false;
  if (!(await AppRepository.activate(app.rowId, app.organizationId))) {
    // Deleted or disabled since the request looked it up.
    return false;
  }
  logEvent("app.activated", { app: app.appId, org: app.organizationId });
  const target = syncTarget(app);
  if (target) scheduleCatalogResync(target, "first_use");
  return true;
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
