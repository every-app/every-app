/**
 * The apps' Access application, kept in step with the registry: which app
 * hosts have a public surface (public routes, bearer routes, or `mcp` in
 * the manifest),
 * and what the application on `*.<base>` lets through on each. `access on`
 * creates and reconciles it; a deploy or a delete calls
 * `syncAppsAccessAfter` so an app's new public routes (and its `/mcp`) are
 * reachable without a login as soon as the app is, and a deleted app's
 * destination goes. With no apps application there is nothing to do:
 * Access isn't in front of the Gateway.
 *
 * Only destinations that are ours change (the wildcard and hosts one label
 * below the base domain); a destination for anything else on the same
 * application is kept as found and named in a warning. The work runs under
 * its own lease, so two deploys finishing together don't each PUT a list
 * without the other's host.
 */
import { storedBearerRoutes, storedMcp, storedPublicRoutes } from "@/lib/app/publicRoutes";
import type { D1Database } from "@/lib/cf/d1";
import {
  applicationUpdateBody,
  listAccessApplications,
  updateAccessApplication,
  type AccessApplication,
} from "@/lib/cf/access";
import type { CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import type { InstallRecord } from "@/lib/gateway/install";
import { ACCESS_LEASE_ID, acquireLease, LeasePurpose } from "@/lib/gateway/lease";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { listed, plural } from "@/lib/output/text";
import {
  appsDestinations,
  findAccessApplications,
  managedOAuthOn,
  sameDestinations,
  splitDestinations,
  type AccessScope,
  type AppPublicSurface,
  type DroppedRoute,
} from "./plan";

/** The statuses of apps the Gateway serves (and so Access must let through). */
const SERVED_STATUSES = ["binding", "active", "disabled"];

/** How long a sync waits for another run's hold on the Access applications. */
const SYNC_LEASE_WAIT_MS = 60_000;

/**
 * Every served app's host, the public and bearer routes of the manifest it
 * was last deployed from and whether that manifest sets `mcp`, by host. A row
 * without a hostname, or whose manifest won't parse, has no public surface.
 */
export async function readPublicSurfaces(db: D1Database): Promise<AppPublicSurface[]> {
  const [rows = []] = await db.run([
    {
      sql: `SELECT app_slug, hostname, manifest FROM apps
WHERE status IN (${SERVED_STATUSES.map((status) => `'${status}'`).join(", ")}) AND hostname IS NOT NULL
ORDER BY hostname`,
    },
  ]);
  return rows.map((row) => ({
    appId: String(row["app_slug"]),
    hostname: String(row["hostname"]),
    publicPaths: storedPublicRoutes(row["manifest"]).map((route) => route.path),
    bearerPaths: storedBearerRoutes(row["manifest"]),
    mcp: storedMcp(row["manifest"]) !== null,
  }));
}

/** What an app opens without a login, as the sync after a deploy or delete names it. */
interface PublicSurfaceFlags {
  publicRoutes: boolean;
  /** The manifest sets `bearerRoutes`: they and the discovery document are let through. */
  bearerRoutes?: boolean;
  /** The manifest sets `mcp`: its host's `/mcp` is let through (unless Managed OAuth is on). */
  mcp: boolean;
}

/** "public routes", "bearer routes and /mcp", ...: what the app has, for the sync's lines. */
function surfaceWords({ publicRoutes, bearerRoutes = false, mcp }: PublicSurfaceFlags): string {
  const words = [
    ...(publicRoutes ? ["public routes"] : []),
    ...(bearerRoutes ? ["bearer routes"] : []),
    ...(mcp ? ["/mcp"] : []),
  ];
  return words.length > 0 ? listed(words) : "public routes";
}

/** What the plan leaves out, for the warnings. */
export interface PlanLeftovers {
  dropped: DroppedRoute[];
  outsideBase: string[];
  /** Destinations on a found application that aren't ours, kept as they are. */
  foreign: Array<{ application: string; uris: string[] }>;
}

/** What a sync found and did. */
interface AppsAccessSync extends PlanLeftovers {
  application: AccessApplication;
  changed: boolean;
}

export const scopeOf = (install: InstallRecord): AccessScope => ({
  gatewayHost: install.gatewayHost.toLowerCase(),
  appBaseDomain: install.appBaseDomain.toLowerCase(),
});

/**
 * Bring the apps application's destinations up to date with the registry,
 * under the Access lease, on a fresh read of both (the caller saw an apps
 * application; it may have changed since).
 */
async function syncAppsAccess({
  cf,
  db,
  install,
  out,
}: {
  cf: CfRunner;
  db: D1Database;
  install: InstallRecord;
  out: EventSink;
}): Promise<AppsAccessSync | null> {
  const scope = scopeOf(install);
  const lease = await acquireLease({
    db,
    id: ACCESS_LEASE_ID,
    purpose: LeasePurpose.AccessSync,
    out,
    step: "gateway.lease",
    waitMs: SYNC_LEASE_WAIT_MS,
  });
  try {
    const found = findAccessApplications(await listAccessApplications(cf), scope);
    if (!found.apps) return null;
    await lease.check();
    return await reconcileAppsDestinations({ cf, db, install, application: found.apps, gateway: found.gateway });
  } finally {
    await lease.release();
  }
}

/**
 * The apps application's destinations from the registry, PUT only when
 * they differ. Destinations that aren't ours stay as found; so does the
 * Gateway host's when one application covers both.
 */
async function reconcileAppsDestinations({
  cf,
  db,
  install,
  application,
  gateway,
}: {
  cf: CfRunner;
  db: D1Database;
  install: InstallRecord;
  application: AccessApplication;
  /** The Gateway host's application: its Managed OAuth decides the MCP bypass; the same one when combined. */
  gateway: AccessApplication | null;
}): Promise<AppsAccessSync> {
  const scope = scopeOf(install);
  const plan = appsDestinations(scope.appBaseDomain, await readPublicSurfaces(db), {
    managedOAuth: managedOAuthOn(gateway),
  });
  const current = application.destinations ?? [];
  const { foreign } = splitDestinations(current, scope);
  const gatewayHostKept =
    gateway?.id === application.id
      ? current.filter((d) => (d.uri ?? "").toLowerCase().replace(/\/+$/, "") === scope.gatewayHost)
      : [];
  const destinations = [...foreign, ...gatewayHostKept, ...plan.destinations];
  const leftovers: PlanLeftovers = {
    dropped: plan.dropped,
    outsideBase: plan.outsideBase,
    foreign:
      foreign.length > 0
        ? [{ application: application.name ?? application.id, uris: foreign.map((d) => d.uri ?? "(private)") }]
        : [],
  };
  if (sameDestinations(current, destinations)) return { application, changed: false, ...leftovers };
  const updated = await updateAccessApplication(
    cf,
    application.id,
    applicationUpdateBody(application, { destinations: destinations as never }),
  );
  return { application: updated, changed: true, ...leftovers };
}

/** The warnings a plan's leftovers deserve, once per run. */
export function emitPlanWarnings(out: EventSink, plan: PlanLeftovers): void {
  const inexpressible = plan.dropped.filter((route) => route.reason === "not_expressible");
  const overflow = plan.dropped.filter((route) => route.reason === "too_many");
  const stays = (count: number) => (count === 1 ? "A route stays" : `${count} routes stay`);
  const named = (route: DroppedRoute) => `${route.appId} ${route.path}${route.bearer ? " (bearer)" : ""}`;
  if (inexpressible.length > 0) {
    out.emit({
      type: "warning",
      code: "ACCESS_ROUTE_NOT_EXPRESSIBLE",
      step: "access.routes",
      message: `${stays(inexpressible.length)} behind Access: ${listed(inexpressible.map(named))}\nAccess path patterns take one * per segment, so these have no equivalent. People signed in to Access still reach them.`,
      data: { routes: inexpressible },
    });
  }
  if (overflow.length > 0) {
    out.emit({
      type: "warning",
      code: "ACCESS_TOO_MANY_PUBLIC_ROUTES",
      step: "access.routes",
      message: `${stays(overflow.length)} behind Access: ${listed(overflow.map(named))}\nAccess lets through at most 25 paths per host (two of them for /mcp where the manifest sets mcp, one for the discovery document where it sets bearerRoutes). Merge routes under one prefix, or keep these behind the login.`,
      data: { routes: overflow },
    });
  }
  if (plan.outsideBase.length > 0) {
    out.emit({
      type: "warning",
      code: "ACCESS_APP_OUTSIDE_BASE",
      step: "access.routes",
      message: `${listed(plan.outsideBase)} ${plan.outsideBase.length === 1 ? "isn't" : "aren't"} under the apps' domain, so Access isn't set up for ${plan.outsideBase.length === 1 ? "it" : "them"}.`,
      data: { apps: plan.outsideBase },
    });
  }
  for (const { application, uris } of plan.foreign) {
    out.emit({
      type: "warning",
      code: "ACCESS_FOREIGN_DESTINATION",
      step: "access.routes",
      message: `The Access application "${application}" also covers ${listed(uris)}\n${plural(uris.length, "That destination").replace(/^1 That destination/, "That destination").replace(/^(\d+) That destinations?/, "Those $1 destinations")} ${uris.length === 1 ? "isn't" : "aren't"} EveryApp's and ${uris.length === 1 ? "stays" : "stay"} as ${uris.length === 1 ? "it is" : "they are"}. access off won't delete this application.`,
      data: { application, uris },
    });
  }
}

/**
 * After a deploy or a delete: keep the apps application in step, saying so
 * only when something changed, and never failing the run for it. Whether
 * Access is in front at all costs one list call; a login without the
 * Access permissions (a CI token) can't make it, which is said only when
 * the app has a public surface (public routes, or `mcp` in its manifest),
 * the one thing a sync would change for it, and without claiming the
 * Gateway is behind Access.
 */
export async function syncAppsAccessAfter(
  options: { cf: CfRunner; db: D1Database; install: InstallRecord; out: EventSink },
  { appId, surface, removing = false }: { appId: string; surface: PublicSurfaceFlags; removing?: boolean },
): Promise<void> {
  const { cf, install, out } = options;
  const rerun = `${CLI} access on`;
  const what = surfaceWords(surface);
  let applications: AccessApplication[];
  try {
    applications = await listAccessApplications(cf);
  } catch (error) {
    const permission = error instanceof EveryAppError && error.code === "ACCESS_PERMISSION_MISSING";
    if (permission && !surface.publicRoutes && !surface.bearerRoutes && !surface.mcp) return;
    const until = removing
      ? `If the Gateway is behind Access, ${appId}'s host stays listed there until it is updated.`
      : `If the Gateway is behind Access, ${appId}'s ${what} need a login there until it is updated.`;
    out.emit({
      type: "warning",
      code: "ACCESS_NOT_CHECKED",
      step: "app.access",
      message: permission
        ? `This Cloudflare login can't read Cloudflare Access, so ${appId} wasn't checked against it\n${until}`
        : `Couldn't check Cloudflare Access for ${appId}\n${errorMessage(error).split("\n")[0]}\n${until}`,
      data: {
        appId,
        rerun,
        rerunNote: permission ? "with a login that can manage Access, if the Gateway is behind it" : "if the Gateway is behind Access",
      },
    });
    return;
  }
  if (!findAccessApplications(applications, scopeOf(install)).apps) return;
  try {
    const sync = await syncAppsAccess(options);
    if (!sync) return;
    emitPlanWarnings(out, sync);
    const message = removing
      ? sync.changed
        ? `Cloudflare Access no longer lets ${appId}'s ${what} through.`
        : `Cloudflare Access had nothing of ${appId}'s to take back.`
      : sync.changed
        ? `Cloudflare Access lets ${appId}'s ${what} through.`
        : `Cloudflare Access already matched ${appId}'s ${what}.`;
    out.emit({
      type: "step",
      step: "app.access",
      status: sync.changed ? "ok" : "skip",
      message,
      data: { appId, applicationId: sync.application.id, changed: sync.changed, removed: removing },
    });
  } catch (error) {
    out.emit({
      type: "warning",
      code: "ACCESS_SYNC_FAILED",
      step: "app.access",
      message: `Couldn't update Cloudflare Access for ${appId}'s ${what}\n${errorMessage(error).split("\n")[0]}\n${removing ? `${appId}'s host stays listed there until it is updated.` : "Until it is updated, they need an Access login."}`,
      data: { appId, rerun },
    });
  }
}
