/**
 * What Cloudflare Access should look like in front of a Gateway (the outer
 * ring of docs/runbooks/cloudflare-access.md), worked out from the Gateway's
 * registry, and compared with what Access has. Pure: no cf, no D1, so the
 * rules are tested on their own and `access setup`, `access show` and the
 * sync after a deploy share them.
 *
 * Two hostname-based applications: one on the Gateway's own host (its
 * tokens sign people in), one on `*.<app base domain>` (its tokens only
 * vouch for a session on an app host). The Gateway's lets through only its
 * machine endpoints, which check their own credentials, and `/health` for
 * uptime monitors. The wildcard lets nothing through: an app host serves
 * no MCP unless its manifest says so. Access picks the most specific
 * matching destination, so an app with public routes, bearer routes, or
 * `mcp` in its manifest gets a destination of its own on its host: the MCP
 * paths where the manifest asks for them, then its bearer routes and the
 * discovery document native apps read first, then its public routes.
 *
 * Access path overrides: `*` matches any characters, `/` included; at most
 * one `*` per segment; no implicit subpaths (`/a` is `/a` only); at most 25
 * per destination. The Gateway still decides what is public (its globs
 * are narrower: `*` stays within a segment, methods count), so an override
 * wider than the route it comes from costs nothing.
 */
import type { AccessApplication, AccessDestinationOutput, AccessRule } from "@/lib/cf/access";

const MAX_OVERRIDES_PER_DESTINATION = 25;

/**
 * MCP clients reach `/mcp` with a token of their own: on the Gateway, and
 * on an app host whose manifest sets `mcp` (the Gateway's ToolBus or the
 * app's own server answers there, after the perimeter checked the token).
 */
export const MCP_PATHS: readonly string[] = ["/mcp", "/mcp/*"];

/**
 * Where a native app finds the Gateway for an app host
 * (docs/design/native-sign-in.md, section 12): written by the Gateway
 * from the registry, never proxied. Let through on hosts with bearer
 * routes, the only ones a native app can use behind Access.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

/**
 * The Gateway's `/health`: an uptime monitor can't sign in, and the route
 * reads no session and names no version. Public whatever Managed OAuth
 * says.
 */
const HEALTH_PATH = "/health";

/**
 * Sign in with Apple returns to the Gateway with a cross-site POST
 * (`response_mode=form_post`), which carries no Access login. The POST
 * only redirects to the same URL as a GET, which Access then checks as
 * usual; it creates nothing (docs/runbooks/sign-in-providers.md, "Apple").
 * Public whatever Managed OAuth says: it has nothing to do with MCP.
 */
const APPLE_CALLBACK_PATH = "/api/auth/callback/apple";

/**
 * The Gateway host's machine endpoints: MCP, the OAuth server's token,
 * revocation and registration endpoints, OAuth discovery, `/health`, and
 * Apple's sign-in POST. Everything else on the host, `/oauth/authorize`,
 * the consent page and every other sign-in callback included, is a page
 * for people and stays behind Access.
 */
const GATEWAY_BYPASS_PATHS: readonly string[] = [
  ...MCP_PATHS,
  "/oauth/token",
  "/oauth/register",
  // `everyapp dev --gateway` (docs/design/linked-dev.md): a bearer-only
  // route that checks its own credential: 401 to every token until an
  // organization opts in, 404 only with the OAuth server off.
  "/linked-dev/*",
  "/.well-known/*",
  HEALTH_PATH,
  APPLE_CALLBACK_PATH,
];

interface AccessOverride {
  path_pattern: string;
  behavior: "public";
}

export interface AccessPublicDestination {
  type: "public";
  uri: string;
  overrides: AccessOverride[];
}

/** The longest path pattern Access takes. */
const MAX_PATTERN_LENGTH = 512;

/**
 * A manifest public route's path as an Access `path_pattern`, or null when
 * Access can't express it: `**` becomes `*` (Access's `*` spans segments
 * already), a `:name` segment becomes `*`, and a segment left with two
 * wildcards (`/a*b*`) has no equivalent.
 */
export function accessPathPattern(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").map((segment, index) => {
    if (index === 0) return segment;
    const collapsed = segment.replace(/\*{2,}/g, "*");
    return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(collapsed) ? "*" : collapsed;
  });
  if (segments.some((segment) => (segment.match(/\*/g) ?? []).length > 1)) return null;
  const pattern = segments.join("/");
  return pattern.length > MAX_PATTERN_LENGTH ? null : pattern;
}

const overridesFor = (patterns: readonly string[]): AccessOverride[] =>
  patterns.map((path_pattern) => ({ path_pattern, behavior: "public" }));

/** An app as the plan sees it: its host, its manifest's public and bearer routes, and whether the manifest sets `mcp`. */
export interface AppPublicSurface {
  appId: string;
  hostname: string;
  publicPaths: readonly string[];
  /** The manifest's `bearerRoutes.paths`: paths native apps call with a token, which take no cookie. */
  bearerPaths: readonly string[];
  /** The stored manifest has `mcp: { by, why }`: its host serves `/mcp`, which MCP clients reach with a token. */
  mcp: boolean;
}

/** Whether an app needs a destination of its own: something on its host is reached without a login. */
const hasPublicSurface = (app: Pick<AppPublicSurface, "publicPaths" | "bearerPaths" | "mcp">): boolean =>
  app.publicPaths.length > 0 || app.bearerPaths.length > 0 || app.mcp;

/** A public or bearer route Access won't let through, and why. */
export interface DroppedRoute {
  appId: string;
  path: string;
  /** No Access pattern for it, or the destination's 25 overrides are used up. */
  reason: "not_expressible" | "too_many";
  /** Set on one of the manifest's `bearerRoutes`. */
  bearer?: true;
}

/**
 * The destination for an app with a public surface: the MCP paths when its
 * manifest sets `mcp` (unless Managed OAuth makes AI apps use the
 * Gateway's `/mcp` through Access), then, when it has bearer routes, the
 * discovery document and those routes, then its public routes, each in
 * manifest order, each once, up to the limit. Bearer routes are bypassed
 * whatever Managed OAuth says: they take a Gateway token and no cookie.
 */
export function appDestination(
  app: AppPublicSurface,
  { managedOAuth }: { managedOAuth: boolean },
): {
  destination: AccessPublicDestination;
  dropped: DroppedRoute[];
} {
  const patterns = app.mcp && !managedOAuth ? [...MCP_PATHS] : [];
  if (app.bearerPaths.length > 0) patterns.push(PROTECTED_RESOURCE_METADATA_PATH);
  const dropped: DroppedRoute[] = [];
  const add = (path: string, bearer: boolean) => {
    const marker = bearer ? { bearer: true as const } : {};
    const pattern = accessPathPattern(path);
    if (pattern === null) {
      dropped.push({ appId: app.appId, path, reason: "not_expressible", ...marker });
      return;
    }
    if (patterns.includes(pattern)) return;
    if (patterns.length >= MAX_OVERRIDES_PER_DESTINATION) {
      dropped.push({ appId: app.appId, path, reason: "too_many", ...marker });
      return;
    }
    patterns.push(pattern);
  };
  for (const path of app.bearerPaths) add(path, true);
  for (const path of app.publicPaths) add(path, false);
  return {
    destination: { type: "public", uri: app.hostname.toLowerCase(), overrides: overridesFor(patterns) },
    dropped,
  };
}

/** The Gateway host's destination; with Managed OAuth on, only `/health` and Apple's sign-in POST are bypassed. */
export function gatewayDestination(gatewayHost: string, managedOAuth: boolean): AccessPublicDestination {
  return {
    type: "public",
    uri: gatewayHost.toLowerCase(),
    overrides: overridesFor(managedOAuth ? [HEALTH_PATH, APPLE_CALLBACK_PATH] : GATEWAY_BYPASS_PATHS),
  };
}

/** `*.<base>`: every app host. */
const appsWildcard = (appBaseDomain: string): string => `*.${appBaseDomain.toLowerCase()}`;

/** Whether `hostname` is one label below `base` (the hosts the wildcard covers). */
function underBase(hostname: string, base: string): boolean {
  const host = hostname.toLowerCase();
  const suffix = `.${base.toLowerCase()}`;
  return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".") && host.length > suffix.length;
}

/**
 * The apps application's destinations: the wildcard, with nothing let
 * through, then one per app with a public surface (public routes, bearer
 * routes, or `mcp` in its manifest) under the base domain, by host. Apps with neither
 * need none (the wildcard covers them). With Managed OAuth on the Gateway's
 * application, nothing bypasses `/mcp` on app hosts either: AI apps use
 * the Gateway's, through Access, so an app with `mcp` alone gets no
 * destination then (one with no override would let nothing through).
 */
export function appsDestinations(
  appBaseDomain: string,
  apps: readonly AppPublicSurface[],
  { managedOAuth = false }: { managedOAuth?: boolean } = {},
): { destinations: AccessPublicDestination[]; dropped: DroppedRoute[]; outsideBase: string[] } {
  const destinations: AccessPublicDestination[] = [
    { type: "public", uri: appsWildcard(appBaseDomain), overrides: [] },
  ];
  const dropped: DroppedRoute[] = [];
  const outsideBase: string[] = [];
  for (const app of [...apps].sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    if (!hasPublicSurface(app)) continue;
    if (!underBase(app.hostname, appBaseDomain)) {
      outsideBase.push(app.appId);
      continue;
    }
    const planned = appDestination(app, { managedOAuth });
    dropped.push(...planned.dropped);
    if (planned.destination.overrides.length === 0) continue;
    destinations.push(planned.destination);
  }
  return { destinations, dropped, outsideBase };
}

/** What the Gateway's host and base domain make ours. */
export interface AccessScope {
  gatewayHost: string;
  appBaseDomain: string;
}

/**
 * Whether a destination is one of ours: the Gateway's host, the apps'
 * wildcard, or a host one label below the base domain (an app's). Anything
 * else on an application we found belongs to something else, and is kept
 * as it is.
 */
export function isOwnedUri(uri: string | null | undefined, scope: AccessScope): boolean {
  const value = normalUri(uri);
  if (!value || value.includes("/")) return false;
  return (
    value === scope.gatewayHost.toLowerCase() ||
    value === appsWildcard(scope.appBaseDomain) ||
    underBase(value, scope.appBaseDomain)
  );
}

/** An application's destinations split into ours and everything else's. */
export function splitDestinations<T extends { uri?: string | null | undefined }>(
  destinations: readonly T[],
  scope: AccessScope,
): { owned: T[]; foreign: T[] } {
  const owned: T[] = [];
  const foreign: T[] = [];
  for (const destination of destinations) {
    (isOwnedUri(destination.uri, scope) ? owned : foreign).push(destination);
  }
  return { owned, foreign };
}

/** A destination's uri as Access compares it: lowercase, no trailing slash. */
const normalUri = (uri: string | null | undefined) => (uri ?? "").toLowerCase().replace(/\/+$/, "");

function normalDestinations(destinations: ReadonlyArray<AccessDestinationOutput | AccessPublicDestination>) {
  return destinations
    .map((destination) => ({
      type: destination.type ?? "public",
      uri: normalUri(destination.uri),
      overrides: [...(destination.overrides ?? [])]
        .map((override) => `${override.behavior}:${override.path_pattern}`)
        .sort(),
    }))
    .sort((a, b) => a.uri.localeCompare(b.uri));
}

/** Whether two destination lists mean the same thing to Access. */
export function sameDestinations(
  a: ReadonlyArray<AccessDestinationOutput | AccessPublicDestination>,
  b: ReadonlyArray<AccessDestinationOutput | AccessPublicDestination>,
): boolean {
  return JSON.stringify(normalDestinations(a)) === JSON.stringify(normalDestinations(b));
}

/** Whether the application has a public destination on exactly `uri`. */
function hasPublicDestination(application: AccessApplication, uri: string): boolean {
  return (
    application.type === "self_hosted" &&
    (application.destinations ?? []).some(
      (destination) =>
        (destination.type ?? "public") === "public" && normalUri(destination.uri) === normalUri(uri),
    )
  );
}

/**
 * The applications in front of the Gateway, found by what they cover, not
 * by name: the one with the Gateway's host, and the one with the apps'
 * wildcard. One application covering both (the runbook allows it) is
 * returned as both.
 */
export function findAccessApplications(
  applications: readonly AccessApplication[],
  { gatewayHost, appBaseDomain }: AccessScope,
): { gateway: AccessApplication | null; apps: AccessApplication | null } {
  // Another Gateway's applications (named "Every App gateway (<name>)",
  // "Every App apps (<name>)", or the default's without a suffix) are never
  // this Gateway's, whatever destinations they hold: a stray per-app
  // destination equal to this Gateway's host must not hand them over.
  const own = applications.filter((application) => !isAnotherGatewaysApplication(application, gatewayHost));
  return {
    gateway: own.find((application) => hasPublicDestination(application, gatewayHost)) ?? null,
    apps: own.find((application) => hasPublicDestination(application, appsWildcard(appBaseDomain))) ?? null,
  };
}

/** The shape of every Gateway's application names (lib/access/applications.ts `accessApplicationNames`). */
const GATEWAY_APPLICATION_NAME_PATTERN = /^Every App (gateway|apps)(?: \(([a-z0-9]{1,16})\))?$/;

/**
 * Whether an application is named as one of Every App's but covers another
 * Gateway's host as its own: its name's suffix (none for the default) isn't
 * the one this Gateway's host would carry. Judged by the host alone, since
 * the default Gateway's application and a named one's cover different
 * hosts; one whose primary destination is this very host is ours.
 */
function isAnotherGatewaysApplication(application: AccessApplication, gatewayHost: string): boolean {
  const match = GATEWAY_APPLICATION_NAME_PATTERN.exec(application.name ?? "");
  if (!match) return false;
  const domain = application["domain"];
  const primary = typeof domain === "string" ? domain.toLowerCase().replace(/\/.*$/, "") : "";
  if (!primary) return false;
  // Ours when its primary destination is this host or the apps' wildcard under it.
  return primary !== gatewayHost && primary !== appsWildcard(gatewayHost);
}

/** Whether Access handles OAuth for the application (Managed OAuth). */
export const managedOAuthOn = (application: AccessApplication | null): boolean =>
  application?.oauth_configuration?.enabled === true;

// --- Drift ------------------------------------------------------------------

/**
 * What the live applications have that differs from what `on` would make
 * of them, by host (`<gateway host>`, `*.<base>`): the bypass paths, the
 * sign-in methods, and the application being there at all. Empty lists
 * mean in step. `status`, `access show` and the reconcile after a Gateway
 * deploy all read it, so they never disagree.
 */
export interface AccessDrift {
  /** Hosts whose application lets other paths through than the plan. */
  paths: string[];
  /** Hosts whose application doesn't allow the sign-in methods `on` vouches for, as `on` would leave it. */
  signIn: string[];
  /** Hosts with no application in front. */
  missing: string[];
}

/** Whether a drift names anything. */
export const hasDrift = (drift: AccessDrift): boolean =>
  drift.paths.length > 0 || drift.signIn.length > 0 || drift.missing.length > 0;

/**
 * The drift of the applications found against the plan: the Gateway
 * host's destination against `gatewayDestination` (Managed OAuth read
 * from the application), the apps' destinations against
 * `appsDestinations`' (one application covering both hosts is read twice,
 * each half against its own plan), each application's sign-in settings
 * against `signInInSync`.
 */
export function accessDrift({
  scope,
  found,
  surfaces,
  providerIds,
}: {
  scope: AccessScope;
  found: { gateway: AccessApplication | null; apps: AccessApplication | null };
  surfaces: readonly AppPublicSurface[];
  providerIds: readonly string[];
}): AccessDrift {
  const gatewayHost = scope.gatewayHost.toLowerCase();
  const wildcard = appsWildcard(scope.appBaseDomain);
  const managedOAuth = managedOAuthOn(found.gateway);
  const plan = appsDestinations(scope.appBaseDomain, surfaces, { managedOAuth });
  const combined = found.gateway !== null && found.gateway.id === found.apps?.id;
  const ours = (application: AccessApplication) => splitDestinations(application.destinations ?? [], scope).owned;
  const drift: AccessDrift = { paths: [], signIn: [], missing: [] };
  if (found.gateway) {
    const gatewayOwn = ours(found.gateway).filter((d) => normalUri(d.uri) === gatewayHost);
    if (!sameDestinations(gatewayOwn, [gatewayDestination(gatewayHost, managedOAuth)])) drift.paths.push(gatewayHost);
    if (!signInInSync(found.gateway, providerIds)) drift.signIn.push(gatewayHost);
  } else {
    drift.missing.push(gatewayHost);
  }
  if (found.apps) {
    const appsOwn = ours(found.apps).filter((d) => !combined || normalUri(d.uri) !== gatewayHost);
    if (!sameDestinations(appsOwn, plan.destinations)) drift.paths.push(wildcard);
    if (!combined && !signInInSync(found.apps, providerIds)) drift.signIn.push(wildcard);
  } else {
    drift.missing.push(wildcard);
  }
  return drift;
}

// --- Policy rules -----------------------------------------------------------

export const emailRule = (email: string): AccessRule => ({ email: { email: email.toLowerCase() } });
export const emailDomainRule = (domain: string): AccessRule => ({
  email_domain: { domain: domain.toLowerCase() },
});

/** A rule as compared: its one key and lowercased string values. */
function ruleKey(rule: AccessRule): string {
  return JSON.stringify(rule, (_key, value: unknown) =>
    typeof value === "string" ? value.toLowerCase() : value,
  );
}

/**
 * The policy's include rules with `wanted` added: never fewer (taking
 * someone off is Every App's deactivation, or a change in the dashboard).
 */
export function mergeRules(
  existing: readonly AccessRule[],
  wanted: readonly AccessRule[],
): { include: AccessRule[]; added: AccessRule[] } {
  const seen = new Set(existing.map(ruleKey));
  const added: AccessRule[] = [];
  for (const rule of wanted) {
    const key = ruleKey(rule);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(rule);
  }
  return { include: [...existing, ...added], added };
}

/** The emails a rule list lets in by name, for showing. */
export function ruleEmails(rules: readonly AccessRule[]): string[] {
  return rules.flatMap((rule) => {
    const email = (rule["email"] as { email?: unknown } | undefined)?.email;
    return typeof email === "string" ? [email] : [];
  });
}

/** The email domains a rule list lets in, for showing. */
export function ruleDomains(rules: readonly AccessRule[]): string[] {
  return rules.flatMap((rule) => {
    const domain = (rule["email_domain"] as { domain?: unknown } | undefined)?.domain;
    return typeof domain === "string" ? [domain] : [];
  });
}

// --- Identity providers -----------------------------------------------------

/**
 * "Sign in with Cloudflare": the person's own Cloudflare account, with
 * Cloudflare's MFA. With `restrict_to_account_members` on, only members of
 * the operator's Cloudflare account can use it; off, any Cloudflare user
 * can (subject to the policy), and Cloudflare's docs don't say the address
 * it asserts is verified.
 */
export const CLOUDFLARE_IDP_TYPE = "cloudflare";

/** The one-time PIN: a code emailed to the address the person types. */
export const ONE_TIME_PIN_IDP_TYPE = "onetimepin";

/**
 * Provider kinds that let a person pick their own email address, so Access
 * would assert an address nobody verified (the runbook's "Verified emails").
 */
export const UNVERIFIED_EMAIL_IDP_TYPES: readonly string[] = ["oidc", "saml"];

/** A provider as the sign-in rules read it. */
interface SignInProvider {
  id: string;
  type: string;
  name?: string | null | undefined;
  config?: { restrict_to_account_members?: boolean | null | undefined } | null | undefined;
}

/**
 * The two sign-in methods `access on` keeps on every team, so members of
 * the operator's Cloudflare account sign in with it and everyone else gets
 * a code by email: which of them the team lacks.
 */
export function missingSignInProviders(providers: readonly SignInProvider[]): {
  cloudflare: boolean;
  pin: boolean;
} {
  return {
    cloudflare: !providers.some((provider) => provider.type === CLOUDFLARE_IDP_TYPE),
    pin: !providers.some((provider) => provider.type === ONE_TIME_PIN_IDP_TYPE),
  };
}

/** Cloudflare-account providers open to any Cloudflare user, not only the account's members. */
export function unrestrictedCloudflareProviders<T extends SignInProvider>(providers: readonly T[]): T[] {
  return providers.filter(
    (provider) =>
      provider.type === CLOUDFLARE_IDP_TYPE && provider.config?.restrict_to_account_members !== true,
  );
}

/**
 * The sign-in methods as a person reads them: "a Cloudflare account or a
 * one-time PIN", other providers by name ("a Cloudflare account, Okta or a
 * one-time PIN"). The Cloudflare account first, the PIN last.
 */
export function describeSignInMethods(providers: readonly SignInProvider[]): string {
  const names = [
    ...(providers.some((provider) => provider.type === CLOUDFLARE_IDP_TYPE) ? ["a Cloudflare account"] : []),
    ...providers
      .filter((provider) => provider.type !== CLOUDFLARE_IDP_TYPE && provider.type !== ONE_TIME_PIN_IDP_TYPE)
      .map((provider) => provider.name ?? provider.type),
    ...(providers.some((provider) => provider.type === ONE_TIME_PIN_IDP_TYPE) ? ["a one-time PIN"] : []),
  ];
  return names.length <= 1 ? (names[0] ?? "no sign-in method") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * The providers `access on` allows on the Every App applications: the
 * one-time PIN and a Cloudflare provider restricted to the account's
 * members, the two it vouches for (each asserts an address someone
 * verified: the mailbox, or the Cloudflare account). The Zero Trust team
 * is account-wide, so a provider on it says nothing about who should sign
 * in here: an operator's own (Okta, a generic OIDC one, a Cloudflare
 * provider open to any Cloudflare account) is theirs to allow in the
 * dashboard, and `on` never takes one off an application.
 */
export function allowedSignInProviders<T extends SignInProvider>(providers: readonly T[]): T[] {
  return providers.filter(
    (provider) =>
      provider.type === ONE_TIME_PIN_IDP_TYPE ||
      (provider.type === CLOUDFLARE_IDP_TYPE && provider.config?.restrict_to_account_members === true),
  );
}

/**
 * The provider ids an application should allow: the ones it allows already
 * (an operator's own stay) plus the providers `access on` vouches for
 * (`allowedSignInProviders`). An empty list means "every provider" to
 * Access, the operator's included, so a list is always sent.
 */
export function allowedIdpsFor(
  existing: readonly string[] | null | undefined,
  providerIds: readonly string[],
): string[] {
  const ids = [...(existing ?? [])];
  for (const id of providerIds) {
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * An application's sign-in settings as `access on` makes them: the
 * providers it vouches for allowed (beside what the application allowed
 * already), and Access's redirect past its chooser only when that leaves
 * one provider (with two, the person picks Sign in with Cloudflare or the
 * PIN).
 */
export function desiredSignIn(
  application: Pick<AccessApplication, "allowed_idps"> | null,
  providerIds: readonly string[],
): { allowedIdps: string[]; autoRedirect: boolean } {
  const allowedIdps = allowedIdpsFor(application?.allowed_idps, providerIds);
  return { allowedIdps, autoRedirect: allowedIdps.length === 1 };
}

/**
 * Whether an application's sign-in settings are what `access on` would
 * make them. An application that names no provider (Access then allows
 * every provider of the team, the operator's included) reads as out of
 * sync: `on` always writes the explicit list.
 */
export function signInInSync(
  application: Pick<AccessApplication, "allowed_idps" | "auto_redirect_to_identity">,
  providerIds: readonly string[],
): boolean {
  const desired = desiredSignIn(application, providerIds);
  const current = application.allowed_idps ?? [];
  return (
    current.length === desired.allowedIdps.length &&
    desired.allowedIdps.every((id) => current.includes(id)) &&
    (application.auto_redirect_to_identity ?? false) === desired.autoRedirect
  );
}

// --- Session durations ------------------------------------------------------

/** "720h", "30m", "2h45m" in seconds; null when it isn't a duration Access takes. */
export function durationSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(trimmed)) return null;
  const units: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
  let total = 0;
  for (const [, amount, unit] of trimmed.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(amount) * units[unit!]!;
  }
  return total;
}
