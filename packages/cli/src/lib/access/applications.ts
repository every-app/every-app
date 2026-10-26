/**
 * The two Access applications in front of a Gateway, brought in line with
 * the plan (lib/access/plan.ts): what `access on` does in its fourth step,
 * and what `everyapp update` (and `setup` on a live Gateway) does after
 * the Gateway upload, so a release that changes the Gateway's own public
 * paths, or the sign-in methods `on` vouches for, never leaves the live
 * bypass list behind until someone remembers to run `access on`.
 *
 * `reconcileApplication` creates an application, or brings the fields the
 * CLI owns in line (our destinations, our policy among its reusable ones,
 * the cookie settings, the team's sign-in providers among its allowed
 * ones, the session when asked) and keeps everything else as found. No
 * difference, no PUT. `reconcileAccessApplications` does it for both
 * (the apps' first, so its AUD exists before the Gateway's settings name
 * it), or for the one application that covers both hosts.
 *
 * `keepAccessAfterGatewayDeploy` is the hook: whether Access is in front
 * is read from the live applications (as the sync after an app deploy
 * does), never from a flag, so `access off` stays off; nothing is created
 * (that is `on`'s job, and it needs people to let in); a failure is a
 * warning naming `access on`, never a failed update.
 */
import {
  applicationUpdateBody,
  createAccessApplication,
  listAccessApplications,
  listAccessIdentityProviders,
  listAccessPolicies,
  updateAccessApplication,
  type AccessApplication,
  type AccessApplicationBody,
} from "@/lib/cf/access";
import type { D1Database } from "@/lib/cf/d1";
import { isCfError } from "@/lib/cf/errors";
import type { CfRunner } from "@/lib/cf/runner";
import { errorMessage, EveryAppError } from "@/lib/errors";
import { ACCESS_LEASE_ID, acquireLease, LeasePurpose } from "@/lib/gateway/lease";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { listed, plural } from "@/lib/output/text";
import {
  allowedSignInProviders,
  appsDestinations,
  desiredSignIn,
  findAccessApplications,
  gatewayDestination,
  managedOAuthOn,
  MCP_PATHS,
  sameDestinations,
  signInInSync,
  splitDestinations,
  type AccessPublicDestination,
  type AccessScope,
} from "./plan";
import { emitPlanWarnings, readPublicSurfaces, type PlanLeftovers } from "./sync";

/** The reusable policy `on` keeps: who may use Every App. */
export const POLICY_NAME = "Every App gateway members";
/** The two applications' names (`teardown` finds them by these too, with no Gateway left to say what they cover). */
export const GATEWAY_APPLICATION_NAME = "Every App gateway";
export const APPS_APPLICATION_NAME = "Every App apps";
/** The most Access allows for an application's session: a PIN a month, not a day. */
export const DEFAULT_SESSION = "720h";

/** How long the hook after a Gateway deploy waits for another run's hold on the applications. */
const KEEP_LEASE_WAIT_MS = 60_000;

/** What one application ended as. */
export interface ApplicationOutcome {
  application: AccessApplication;
  /** `skipped`: left as found, with a warning saying why. */
  outcome: "created" | "updated" | "unchanged" | "skipped";
  /** The sign-in providers this run allowed on it that it didn't allow before (ids). */
  signInAdded: string[];
}

/** What an application should be. */
interface DesiredApplication {
  scope: AccessScope;
  name: string;
  /** Our destinations; the application's others are kept. */
  destinations: AccessPublicDestination[];
  /** The policy to keep among its reusable ones; null leaves its policies as found (no policy to name). */
  policyId: string | null;
  session: string;
  /** `--session` was given: an existing application's session changes too. */
  sessionGiven: boolean;
  allowedIdps: string[];
  appLauncherVisible: boolean;
  /** The step the progress and warnings go on. */
  step: string;
}

/**
 * Create the application, or bring the fields the CLI owns in line and
 * keep everything else as found. No difference, no PUT.
 */
async function reconcileApplication(
  cf: CfRunner,
  out: EventSink,
  existing: AccessApplication | null,
  desired: DesiredApplication,
): Promise<ApplicationOutcome> {
  const { step } = desired;
  if (!existing) {
    out.emit({ type: "progress", step, message: `Creating the Access application "${desired.name}"` });
    const signIn = desiredSignIn(null, desired.allowedIdps);
    const application = await createAccessApplication(cf, {
      name: desired.name,
      type: "self_hosted",
      destinations: desired.destinations,
      policies: desired.policyId ? [desired.policyId] : [],
      session_duration: desired.session,
      http_only_cookie_attribute: true,
      enable_binding_cookie: true,
      ...(signIn.allowedIdps.length > 0 ? { allowed_idps: signIn.allowedIdps } : {}),
      auto_redirect_to_identity: signIn.autoRedirect,
      app_launcher_visible: desired.appLauncherVisible,
    });
    return { application, outcome: "created", signInAdded: signIn.allowedIdps };
  }
  const current = existing.destinations ?? [];
  const destinations = [...splitDestinations(current, desired.scope).foreign, ...desired.destinations];
  const found = [...(existing.policies ?? [])].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
  const inline = found.filter((policy) => policy.reusable === false);
  if (inline.length > 0) {
    // An application with policies of its own takes no reusable one, and
    // the API replaces it whole on PUT: it is the dashboard's to manage.
    out.emit({
      type: "warning",
      code: "ACCESS_INLINE_POLICIES",
      step,
      message: `The Access application "${existing.name ?? existing.id}" has ${inline.length === 1 ? "a policy" : "policies"} of its own: ${listed(inline.map((policy) => policy.name ?? policy.id))}\nIt is left as it is: Access takes either application policies or reusable ones, not both, so the policy "${POLICY_NAME}" can't be attached and its paths aren't managed here. Make its policies reusable in the dashboard, or manage it there.`,
      data: { application: existing.id, policies: inline.map((policy) => policy.id) },
    });
    return { application: existing, outcome: "skipped", signInAdded: [] };
  }
  const policyIds = found.map((policy) => policy.id);
  const policies =
    desired.policyId === null || policyIds.includes(desired.policyId) ? policyIds : [...policyIds, desired.policyId];
  // Managed OAuth: the runbook leaves the binding cookie as the operator set it.
  const binding = managedOAuthOn(existing) ? (existing.enable_binding_cookie ?? false) : true;
  // The team's sign-in providers join what the application allows already
  // (an application `on` made before Sign in with Cloudflare allowed the
  // PIN alone); none is ever taken off.
  const signIn = desiredSignIn(existing, desired.allowedIdps);
  const signInAdded = signIn.allowedIdps.filter((id) => !(existing.allowed_idps ?? []).includes(id));
  const changes: Partial<AccessApplicationBody> = {
    destinations: destinations as AccessApplicationBody["destinations"],
    policies,
    http_only_cookie_attribute: true,
    enable_binding_cookie: binding,
    allowed_idps: signIn.allowedIdps,
    auto_redirect_to_identity: signIn.autoRedirect,
    ...(desired.sessionGiven ? { session_duration: desired.session } : {}),
  };
  const unchanged =
    sameDestinations(current, destinations) &&
    policies.join(",") === policyIds.join(",") &&
    existing.http_only_cookie_attribute === true &&
    (existing.enable_binding_cookie ?? false) === binding &&
    signInInSync(existing, desired.allowedIdps) &&
    (!desired.sessionGiven || existing.session_duration === desired.session);
  if (unchanged) return { application: existing, outcome: "unchanged", signInAdded: [] };
  out.emit({ type: "progress", step, message: `Updating the Access application "${existing.name ?? desired.name}"` });
  const application = await updateAccessApplication(cf, existing.id, applicationUpdateBody(existing, changes));
  return { application, outcome: "updated", signInAdded };
}

/** The applications as found: the Gateway host's and the apps' wildcard's (`findAccessApplications`). */
type FoundApplications = ReturnType<typeof findAccessApplications>;

/** What reconciling both applications found and did. */
interface ApplicationsOutcome {
  /** Null only when `create` was off and the application wasn't there. */
  apps: ApplicationOutcome | null;
  gateway: ApplicationOutcome | null;
  /** One application covers the Gateway's host and the apps' hosts. */
  combined: boolean;
  leftovers: PlanLeftovers;
  /** The plan's destinations for the apps: the wildcard, then one per app with a public surface. */
  plan: ReturnType<typeof appsDestinations>;
}

/**
 * Both applications against the plan, under the caller's hold on the
 * Access lease (the apps' public routes are read here, so a deploy that
 * finished meanwhile is seen): the apps' first, then the Gateway's; one
 * application covering both is kept as one. With `create` off a missing
 * application is left missing (and reported null): nothing but `on`
 * creates one.
 */
export async function reconcileAccessApplications(
  cf: CfRunner,
  out: EventSink,
  db: D1Database,
  {
    scope,
    found,
    policyId,
    session,
    sessionGiven,
    allowedIdps,
    create,
    step,
  }: {
    scope: AccessScope;
    found: FoundApplications;
    policyId: string | null;
    session: string;
    sessionGiven: boolean;
    allowedIdps: string[];
    create: boolean;
    step: string;
  },
): Promise<ApplicationsOutcome> {
  const { gatewayHost, appBaseDomain: base } = scope;
  const managedOAuth = managedOAuthOn(found.gateway);
  const plan = appsDestinations(base, await readPublicSurfaces(db), { managedOAuth });
  const combined = found.gateway !== null && found.apps !== null && found.gateway.id === found.apps.id;
  const foreign: PlanLeftovers["foreign"] = [];
  const noteForeign = (application: AccessApplication | null) => {
    if (!application) return;
    const split = splitDestinations(application.destinations ?? [], scope).foreign;
    if (split.length > 0) {
      foreign.push({ application: application.name ?? application.id, uris: split.map((d) => d.uri ?? "(private)") });
    }
  };
  const common = { scope, policyId, session, sessionGiven, allowedIdps, step };
  let apps: ApplicationOutcome | null;
  let gateway: ApplicationOutcome | null;
  if (combined) {
    out.emit({
      type: "warning",
      code: "ACCESS_ONE_APPLICATION",
      step,
      message: `One Access application covers ${gatewayHost} and *.${base}\nIt is kept and updated. The runbook recommends two, so an app host's Access cookie is never a Gateway login.`,
    });
    noteForeign(found.gateway);
    const together = await reconcileApplication(cf, out, found.gateway, {
      ...common,
      name: found.gateway!.name ?? GATEWAY_APPLICATION_NAME,
      destinations: [gatewayDestination(gatewayHost, managedOAuth), ...plan.destinations],
      appLauncherVisible: true,
    });
    apps = together;
    gateway = together;
  } else {
    noteForeign(found.apps);
    noteForeign(found.gateway);
    apps =
      found.apps || create
        ? await reconcileApplication(cf, out, found.apps, {
            ...common,
            name: APPS_APPLICATION_NAME,
            destinations: plan.destinations,
            appLauncherVisible: false,
          })
        : null;
    gateway =
      found.gateway || create
        ? await reconcileApplication(cf, out, found.gateway, {
            ...common,
            name: GATEWAY_APPLICATION_NAME,
            destinations: [gatewayDestination(gatewayHost, managedOAuth)],
            appLauncherVisible: true,
          })
        : null;
  }
  return { apps, gateway, combined, leftovers: { dropped: plan.dropped, outsideBase: plan.outsideBase, foreign }, plan };
}

/** How many apps the plan lets public routes, and `/mcp`, through for (the done lines). */
export function planCounts(plan: ReturnType<typeof appsDestinations>): { appsWithRoutes: number; appsWithMcp: number } {
  return {
    appsWithRoutes: plan.destinations.filter((d) => d.overrides.some((o) => !MCP_PATHS.includes(o.path_pattern))).length,
    appsWithMcp: plan.destinations.filter((d) => d.overrides.some((o) => o.path_pattern === "/mcp")).length,
  };
}

/** The step the hook after a Gateway deploy reports on. */
const KEEP_STEP = "gateway.access";

/**
 * After `update` or `setup` deployed (or found up to date) a live Gateway:
 * when Access is in front, bring both applications in line with what this
 * release wants, under the Access lease, and say what changed. Whether
 * Access is in front costs one list call: a login without the Access
 * permissions (a CI token), or an account that never opened Zero Trust,
 * is silent (Access can't be on without them); any other refusal is the
 * warning ACCESS_NOT_CHECKED. Nothing is created, and the Gateway's
 * settings aren't rewritten (an AUD tag that changed is `access on`'s to
 * fix; `status` says so); a failure to update is ACCESS_RECONCILE_FAILED
 * with the rerun, and the deploy still ends done.
 */
export async function keepAccessAfterGatewayDeploy({
  cf,
  db,
  scope,
  out,
}: {
  cf: CfRunner;
  db: D1Database;
  scope: AccessScope;
  out: EventSink;
}): Promise<void> {
  const rerun = `${CLI} access on`;
  let applications: AccessApplication[];
  try {
    applications = await listAccessApplications(cf);
  } catch (error) {
    if (error instanceof EveryAppError && error.code === "ACCESS_PERMISSION_MISSING") return;
    if (isCfError(error, "access_not_enabled")) return;
    out.emit({
      type: "warning",
      code: "ACCESS_NOT_CHECKED",
      step: KEEP_STEP,
      message: `Couldn't check Cloudflare Access after the Gateway deploy\n${errorMessage(error).split("\n")[0]}\nIf the Gateway is behind Access, the paths it lets through may be out of step with this release until it is updated.`,
      data: { rerun, rerunNote: "if the Gateway is behind Access" },
    });
    return;
  }
  const seen = findAccessApplications(applications, scope);
  if (!seen.gateway && !seen.apps) return;
  try {
    const lease = await acquireLease({
      db,
      id: ACCESS_LEASE_ID,
      purpose: LeasePurpose.AccessSync,
      out,
      step: "gateway.lease",
      waitMs: KEEP_LEASE_WAIT_MS,
    });
    let result: ApplicationsOutcome;
    try {
      // Under the lease, a fresh read of everything the plan depends on.
      const found = findAccessApplications(await listAccessApplications(cf), scope);
      if (!found.gateway && !found.apps) return;
      const [providers, policies] = await Promise.all([listAccessIdentityProviders(cf), listAccessPolicies(cf)]);
      await lease.check();
      result = await reconcileAccessApplications(cf, out, db, {
        scope,
        found,
        policyId: policies.find((policy) => policy.name === POLICY_NAME)?.id ?? null,
        session: DEFAULT_SESSION,
        sessionGiven: false,
        allowedIdps: allowedSignInProviders(providers).map((provider) => provider.id),
        create: false,
        step: KEEP_STEP,
      });
    } finally {
      await lease.release();
    }
    emitPlanWarnings(out, result.leftovers);
    const changed = [result.gateway, result.apps]
      .filter((outcome): outcome is ApplicationOutcome => outcome !== null && outcome.outcome === "updated")
      .filter((outcome, index, all) => all.findIndex((other) => other.application.id === outcome.application.id) === index);
    const missing = [
      ...(result.gateway ? [] : [scope.gatewayHost]),
      ...(result.apps ? [] : [`*.${scope.appBaseDomain}`]),
    ];
    if (missing.length > 0) {
      out.emit({
        type: "warning",
        code: "ACCESS_APPLICATION_MISSING",
        step: KEEP_STEP,
        message: `Cloudflare Access has no application in front of ${listed(missing)}\nThe Gateway requires an Access login, and nothing there asks for one: run access on to put it back.`,
        data: { hosts: missing, rerun },
      });
    }
    const counts = planCounts(result.plan);
    const routes =
      counts.appsWithRoutes > 0
        ? `public routes of ${plural(counts.appsWithRoutes, "app")}${counts.appsWithMcp > 0 ? `, /mcp on ${plural(counts.appsWithMcp, "app host")}` : ""}`
        : counts.appsWithMcp > 0
          ? `/mcp on ${plural(counts.appsWithMcp, "app host")}`
          : "no app public routes";
    out.emit({
      type: "step",
      step: KEEP_STEP,
      status: changed.length > 0 ? "ok" : "skip",
      message:
        changed.length > 0
          ? `Cloudflare Access brought in step with this Gateway: ${listed(changed.map((outcome) => outcome.application.name ?? outcome.application.id))} updated (${routes} let through).`
          : "Cloudflare Access already matches this Gateway.",
      data: {
        changed: changed.map((outcome) => outcome.application.id),
        gateway: result.gateway ? { id: result.gateway.application.id, outcome: result.gateway.outcome } : null,
        apps: result.apps ? { id: result.apps.application.id, outcome: result.apps.outcome } : null,
        combined: result.combined,
        missing,
        ...counts,
      },
    });
  } catch (error) {
    out.emit({
      type: "warning",
      code: "ACCESS_RECONCILE_FAILED",
      step: KEEP_STEP,
      message: `Couldn't bring Cloudflare Access in step with this Gateway\n${errorMessage(error).split("\n")[0]}\nUntil it is updated, the paths Access lets through are the previous release's.`,
      data: { rerun },
    });
  }
}
