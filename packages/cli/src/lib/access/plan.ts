/**
 * What Cloudflare Access should look like in front of a Gateway (the outer
 * ring of docs/runbooks/cloudflare-access.md), worked out from the Gateway's
 * registry, and compared with what Access has. Pure: no cf, no D1, so the
 * rules are tested on their own and `access setup`, `access show` and the
 * sync after a deploy share them.
 *
 * Two hostname-based applications: one on the Gateway's own host (its
 * tokens sign people in), one on `*.<app base domain>` (its tokens only
 * vouch for a session on an app host). Each lets through only the machine
 * endpoints, which check their own credentials, and each app's public
 * routes on that app's host: Access picks the most specific matching
 * destination, so an app with public routes gets a destination of its own,
 * with the MCP paths again.
 *
 * Access path overrides: `*` matches any characters, `/` included; at most
 * one `*` per segment; no implicit subpaths (`/a` is `/a` only); at most 25
 * per destination. The Gateway still decides what is public (its globs
 * are narrower: `*` stays within a segment, methods count), so an override
 * wider than the route it comes from costs nothing.
 */
import type { AccessApplication, AccessDestinationOutput, AccessRule } from "@/lib/cf/access";

const MAX_OVERRIDES_PER_DESTINATION = 25;

/** MCP clients reach `/mcp` with a token of their own, on the Gateway and on every app host. */
const MCP_PATHS: readonly string[] = ["/mcp", "/mcp/*"];

/**
 * The Gateway host's machine endpoints: MCP, the OAuth server's token,
 * revocation and registration endpoints, and OAuth discovery. Everything
 * else on the host, `/oauth/authorize` and the consent page included, is a
 * page for people and stays behind Access.
 */
const GATEWAY_BYPASS_PATHS: readonly string[] = [
  ...MCP_PATHS,
  "/oauth/token",
  "/oauth/register",
  "/.well-known/*",
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

/** An app as the plan sees it: its host and its manifest's public routes. */
export interface AppPublicSurface {
  appId: string;
  hostname: string;
  publicPaths: readonly string[];
}

/** A public route Access won't let through, and why. */
export interface DroppedRoute {
  appId: string;
  path: string;
  /** No Access pattern for it, or the destination's 25 overrides are used up. */
  reason: "not_expressible" | "too_many";
}

/**
 * The destination for an app with public routes: the MCP paths (unless
 * Managed OAuth makes AI apps use the Gateway's `/mcp` through Access),
 * then its routes in manifest order, each once, up to the limit.
 */
export function appDestination(
  app: AppPublicSurface,
  { mcp }: { mcp: boolean },
): {
  destination: AccessPublicDestination;
  dropped: DroppedRoute[];
} {
  const patterns = mcp ? [...MCP_PATHS] : [];
  const dropped: DroppedRoute[] = [];
  for (const path of app.publicPaths) {
    const pattern = accessPathPattern(path);
    if (pattern === null) {
      dropped.push({ appId: app.appId, path, reason: "not_expressible" });
      continue;
    }
    if (patterns.includes(pattern)) continue;
    if (patterns.length >= MAX_OVERRIDES_PER_DESTINATION) {
      dropped.push({ appId: app.appId, path, reason: "too_many" });
      continue;
    }
    patterns.push(pattern);
  }
  return {
    destination: { type: "public", uri: app.hostname.toLowerCase(), overrides: overridesFor(patterns) },
    dropped,
  };
}

/** The Gateway host's destination; with Managed OAuth on, nothing is bypassed. */
export function gatewayDestination(gatewayHost: string, managedOAuth: boolean): AccessPublicDestination {
  return {
    type: "public",
    uri: gatewayHost.toLowerCase(),
    overrides: managedOAuth ? [] : overridesFor(GATEWAY_BYPASS_PATHS),
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
 * The apps application's destinations: the wildcard with the MCP paths,
 * then one per app with public routes under the base domain, by host. Apps
 * without public routes need none (the wildcard covers them). With Managed
 * OAuth on the Gateway's application (`mcp: false`), nothing bypasses
 * `/mcp` on app hosts either: AI apps use the Gateway's, through Access.
 */
export function appsDestinations(
  appBaseDomain: string,
  apps: readonly AppPublicSurface[],
  { mcp = true }: { mcp?: boolean } = {},
): { destinations: AccessPublicDestination[]; dropped: DroppedRoute[]; outsideBase: string[] } {
  const destinations: AccessPublicDestination[] = [
    { type: "public", uri: appsWildcard(appBaseDomain), overrides: overridesFor(mcp ? MCP_PATHS : []) },
  ];
  const dropped: DroppedRoute[] = [];
  const outsideBase: string[] = [];
  for (const app of [...apps].sort((a, b) => a.hostname.localeCompare(b.hostname))) {
    if (app.publicPaths.length === 0) continue;
    if (!underBase(app.hostname, appBaseDomain)) {
      outsideBase.push(app.appId);
      continue;
    }
    const planned = appDestination(app, { mcp });
    destinations.push(planned.destination);
    dropped.push(...planned.dropped);
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
  return {
    gateway: applications.find((application) => hasPublicDestination(application, gatewayHost)) ?? null,
    apps:
      applications.find((application) => hasPublicDestination(application, appsWildcard(appBaseDomain))) ??
      null,
  };
}

/** Whether Access handles OAuth for the application (Managed OAuth). */
export const managedOAuthOn = (application: AccessApplication | null): boolean =>
  application?.oauth_configuration?.enabled === true;

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
 * "Cloudflare account members" lets in the Cloudflare account's own users
 * only, so it is no way in for a Gateway's members; every other kind of
 * provider is one the operator added for people.
 */
const CLOUDFLARE_MEMBERS_IDP_TYPE = "cloudflare";

/**
 * Provider kinds that let a person pick their own email address, so Access
 * would assert an address nobody verified (the runbook's "Verified emails").
 */
export const UNVERIFIED_EMAIL_IDP_TYPES: readonly string[] = ["oidc", "saml"];

/** The providers people sign in with: every one but the account-members provider. */
export function peopleIdentityProviders<T extends { type: string }>(providers: readonly T[]): T[] {
  return providers.filter((provider) => provider.type !== CLOUDFLARE_MEMBERS_IDP_TYPE);
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
