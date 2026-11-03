/**
 * The two Access applications in front of a Gateway, as `access on` makes
 * them (the plan is lib/access/plan.ts): one fixed recipe, applied only by
 * `on`. A deploy, a delete and `update` never touch Access.
 *
 * `applyApplication` creates an application, or brings the fields `on`
 * owns in line (our destinations, our policy among its policies, the
 * cookie settings, our sign-in methods among its allowed ones) and keeps
 * everything else as found. No difference, no PUT.
 */
import { DEFAULT_GATEWAY_NAMES, type GatewayNames } from "@every-app/perimeter/manifest";
import { storedBearerRoutes, storedPublicRoutes } from "@/lib/app/publicRoutes";
import {
  applicationUpdateBody,
  createAccessApplication,
  updateAccessApplication,
  type AccessApplication,
  type AccessApplicationBody,
} from "@/lib/cf/access";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import type { InstallRecord } from "@/lib/gateway/install";
import type { EventSink } from "@/lib/output/events";
import { listed } from "@/lib/output/text";
import {
  sameDestinations,
  splitDestinations,
  type AccessPublicDestination,
  type AccessScope,
  type AppPublicSurface,
  type appsDestinations,
} from "./plan";

/** The names of the Access applications and policy of one Gateway. */
interface AccessApplicationNames {
  /** The Gateway host's application. */
  gateway: string;
  /** The apps' wildcard application. */
  apps: string;
  /** The reusable policy `on` keeps: who may use Every App. */
  policy: string;
}

/**
 * The names `on` gives the two applications and the policy (`teardown`
 * finds them by these too, with no Gateway left to say what they cover).
 * The default Gateway keeps the names it always had; a named one's say its
 * name, so two Gateways in one account never share a policy or take each
 * other's applications: "Every App gateway (demo)".
 */
export function accessApplicationNames(names: Pick<GatewayNames, "name">): AccessApplicationNames {
  const suffix = names.name ? ` (${names.name})` : "";
  return {
    gateway: `Every App gateway${suffix}`,
    apps: `Every App apps${suffix}`,
    policy: `Every App gateway members${suffix}`,
  };
}

const DEFAULT_ACCESS_NAMES = accessApplicationNames(DEFAULT_GATEWAY_NAMES);
/** The default Gateway's policy name. */
export const POLICY_NAME = DEFAULT_ACCESS_NAMES.policy;
/** The default Gateway's applications' names. */
export const GATEWAY_APPLICATION_NAME = DEFAULT_ACCESS_NAMES.gateway;
export const APPS_APPLICATION_NAME = DEFAULT_ACCESS_NAMES.apps;
/** How long an Access sign-in lasts: the most Access allows, a PIN a month. */
export const SESSION = "720h";

/** The statuses of apps the Gateway serves (and so Access must let through). */
const SERVED_STATUSES = ["binding", "active", "disabled"];

export const scopeOf = (install: InstallRecord): AccessScope => ({
  gatewayHost: install.gatewayHost.toLowerCase(),
  appBaseDomain: install.appBaseDomain.toLowerCase(),
});

/**
 * Every served app's host and the public and bearer routes of the manifest
 * it was last deployed from, by host. A row without a hostname, or whose
 * manifest won't parse, has no public surface.
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
    publicPaths: storedPublicRoutes(row["manifest"])
      .filter((route) => !route.bearer)
      .map((route) => route.path),
    bearerPaths: storedBearerRoutes(row["manifest"]),
  }));
}

/** What one application ended as. */
export interface ApplicationOutcome {
  application: AccessApplication;
  outcome: "created" | "updated" | "unchanged";
}

/** What an application should be. */
interface DesiredApplication {
  scope: AccessScope;
  name: string;
  /** Our destinations; the application's others are kept. */
  destinations: AccessPublicDestination[];
  policyId: string;
  /** The sign-in methods `on` allows; ones the application allows besides are kept. */
  allowedIdps: string[];
  appLauncherVisible: boolean;
  step: string;
}

/** Create the application, or bring the fields `on` owns in line. */
export async function applyApplication(
  cf: CfRunner,
  out: EventSink,
  existing: AccessApplication | null,
  desired: DesiredApplication,
): Promise<ApplicationOutcome> {
  const { step } = desired;
  if (!existing) {
    out.emit({ type: "progress", step, message: `Creating the Access application "${desired.name}"` });
    const application = await createAccessApplication(cf, {
      name: desired.name,
      type: "self_hosted",
      destinations: desired.destinations,
      policies: [desired.policyId],
      session_duration: SESSION,
      http_only_cookie_attribute: true,
      enable_binding_cookie: true,
      allowed_idps: desired.allowedIdps,
      auto_redirect_to_identity: desired.allowedIdps.length === 1,
      app_launcher_visible: desired.appLauncherVisible,
    });
    return { application, outcome: "created" };
  }
  const current = existing.destinations ?? [];
  const destinations = [...splitDestinations(current, desired.scope).foreign, ...desired.destinations];
  const policyIds = [...(existing.policies ?? [])]
    .sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0))
    .map((policy) => policy.id);
  const policies = policyIds.includes(desired.policyId) ? policyIds : [...policyIds, desired.policyId];
  const allowedBefore = existing.allowed_idps ?? [];
  const allowedIdps = [...allowedBefore, ...desired.allowedIdps.filter((id) => !allowedBefore.includes(id))];
  const autoRedirect = allowedIdps.length === 1;
  const unchanged =
    sameDestinations(current, destinations) &&
    policies.length === policyIds.length &&
    existing.http_only_cookie_attribute === true &&
    existing.enable_binding_cookie === true &&
    allowedIdps.length === allowedBefore.length &&
    (existing.auto_redirect_to_identity ?? false) === autoRedirect;
  if (unchanged) return { application: existing, outcome: "unchanged" };
  out.emit({ type: "progress", step, message: `Updating the Access application "${existing.name ?? desired.name}"` });
  const changes: Partial<AccessApplicationBody> = {
    destinations: destinations as AccessApplicationBody["destinations"],
    policies,
    http_only_cookie_attribute: true,
    enable_binding_cookie: true,
    allowed_idps: allowedIdps,
    auto_redirect_to_identity: autoRedirect,
  };
  const application = await updateAccessApplication(cf, existing.id, applicationUpdateBody(existing, changes));
  return { application, outcome: "updated" };
}

/** What the plan leaves out, as warnings on step `access.routes`. */
export function emitPlanWarnings(out: EventSink, plan: ReturnType<typeof appsDestinations>): void {
  const named = (route: { appId: string; path: string; bearer?: true }) =>
    `${route.appId} ${route.path}${route.bearer ? " (bearer)" : ""}`;
  const stays = (count: number) => (count === 1 ? "A route stays" : `${count} routes stay`);
  const inexpressible = plan.dropped.filter((route) => route.reason === "not_expressible");
  const overflow = plan.dropped.filter((route) => route.reason === "too_many");
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
      message: `${stays(overflow.length)} behind Access: ${listed(overflow.map(named))}\nAccess lets through at most 25 paths per host (one of them for the discovery document where it has bearer routes). Merge routes under one prefix, or keep these behind the login.`,
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
}
