/**
 * What Cloudflare Access should look like in front of a Gateway (the outer
 * ring of docs/runbooks/cloudflare-access.md), worked out from the Gateway's
 * registry. Pure: no cf, no D1, so the rules are tested on their own and
 * `access on`, `access show` and `teardown` share them. Only `access on`
 * writes them: a deploy never touches Access.
 *
 * Two hostname-based applications: one on the Gateway's own host (its
 * tokens sign people in), one on `*.<app base domain>` (its tokens only
 * vouch for a session on an app host). The Gateway's lets through only its
 * machine endpoints, which check their own credentials, and `/health` for
 * uptime monitors. The wildcard lets nothing through: an app host serves
 * no MCP. Access picks the most specific matching destination, so an app
 * with public routes (bearer ones included) gets a destination of its own
 * on its host: its bearer routes and the discovery document native apps
 * read first, then its public routes.
 *
 * Access path overrides: `*` matches any characters, `/` included; at most
 * one `*` per segment; no implicit subpaths (`/a` is `/a` only); at most 25
 * per destination. The Gateway still decides what is public (its globs
 * are narrower: `*` stays within a segment, methods count), so an override
 * wider than the route it comes from costs nothing.
 */
import type {
  AccessApplication,
  AccessDestinationOutput,
  AccessRule,
} from "./access-types";

const MAX_OVERRIDES_PER_DESTINATION = 25;

/**
 * MCP clients reach the Gateway's `/mcp` with a token of their own (an app
 * host serves no MCP: the Gateway's `/mcp` is the one connector).
 */
export const MCP_PATHS: readonly string[] = ["/mcp", "/mcp/*"];

/**
 * Where a native app finds the Gateway for an app host
 * (docs/design/native-sign-in.md, section 12): written by the Gateway
 * from the registry, never proxied. Let through on hosts with bearer
 * routes (`public` entries with `bearer: true`), the only ones a native
 * app can use behind Access.
 */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

/**
 * Where Access asks the Gateway whether someone is a member (the policy's
 * External Evaluation rule, apps/every-app-gateway/src/server/
 * access-evaluation.ts): Access calls both paths from its own servers.
 */
export const ACCESS_EVALUATION_PATHS = {
  evaluate: "/access-evaluation/evaluate",
  keys: "/access-evaluation/keys",
} as const;

/**
 * The Gateway host's machine endpoints: MCP, the OAuth server's token,
 * revocation and registration endpoints, OAuth discovery, `/health` (an
 * uptime monitor can't sign in; the route reads no session), Apple's
 * sign-in POST (a cross-site POST that only redirects to the same URL as
 * a GET, which Access checks as usual: docs/runbooks/sign-in-providers.md,
 * "Apple"), the membership question Access asks, and the OAuth client
 * metadata documents a remote MCP server's authorization server fetches
 * (`/oauth-clients/*`, public by design: no secret in them). Everything else on
 * the host, `/oauth/authorize`, the consent page and every other sign-in
 * callback included, is a page for people and stays behind Access.
 */
export const GATEWAY_BYPASS_PATHS: readonly string[] = [
  ...MCP_PATHS,
  "/oauth/token",
  "/oauth/register",
  // `everyapp dev --gateway` (docs/design/linked-dev.md): a bearer-only
  // route that checks its own credential: 401 to every token until an
  // organization opts in, 404 only with the OAuth server off.
  "/linked-dev/*",
  "/.well-known/*",
  "/health",
  "/api/auth/callback/apple",
  "/access-evaluation/*",
  "/oauth-clients/*",
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
  if (segments.some((segment) => (segment.match(/\*/g) ?? []).length > 1))
    return null;
  const pattern = segments.join("/");
  return pattern.length > MAX_PATTERN_LENGTH ? null : pattern;
}

const overridesFor = (patterns: readonly string[]): AccessOverride[] =>
  patterns.map((path_pattern) => ({ path_pattern, behavior: "public" }));

/** An app as the plan sees it: its host and its manifest's public and bearer routes. */
export interface AppPublicSurface {
  appId: string;
  hostname: string;
  publicPaths: readonly string[];
  /** The manifest's bearer routes (`bearer: true`): paths native apps call with a token, which take no cookie. */
  bearerPaths: readonly string[];
}

/** Whether an app needs a destination of its own: something on its host is reached without a login. */
const hasPublicSurface = (
  app: Pick<AppPublicSurface, "publicPaths" | "bearerPaths">,
): boolean => app.publicPaths.length > 0 || app.bearerPaths.length > 0;

/** A public or bearer route Access won't let through, and why. */
export interface DroppedRoute {
  appId: string;
  path: string;
  /** No Access pattern for it, or the destination's 25 overrides are used up. */
  reason: "not_expressible" | "too_many";
  /** Set on one of the manifest's bearer routes. */
  bearer?: true;
}

/**
 * The destination for an app with a public surface: when it has bearer
 * routes, the discovery document and those routes, then its public routes,
 * each in manifest order, each once, up to the limit.
 */
export function appDestination(app: AppPublicSurface): {
  destination: AccessPublicDestination;
  dropped: DroppedRoute[];
} {
  const patterns: string[] = [];
  if (app.bearerPaths.length > 0)
    patterns.push(PROTECTED_RESOURCE_METADATA_PATH);
  const dropped: DroppedRoute[] = [];
  const add = (path: string, bearer: boolean) => {
    const marker = bearer ? { bearer: true as const } : {};
    const pattern = accessPathPattern(path);
    if (pattern === null) {
      dropped.push({
        appId: app.appId,
        path,
        reason: "not_expressible",
        ...marker,
      });
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
    destination: {
      type: "public",
      uri: app.hostname.toLowerCase(),
      overrides: overridesFor(patterns),
    },
    dropped,
  };
}

/** The Gateway host's destination, with its machine endpoints let through. */
export function gatewayDestination(
  gatewayHost: string,
): AccessPublicDestination {
  return {
    type: "public",
    uri: gatewayHost.toLowerCase(),
    overrides: overridesFor(GATEWAY_BYPASS_PATHS),
  };
}

/** `*.<base>`: every app host. */
const appsWildcard = (appBaseDomain: string): string =>
  `*.${appBaseDomain.toLowerCase()}`;

/** Whether `hostname` is one label below `base` (the hosts the wildcard covers). */
function underBase(hostname: string, base: string): boolean {
  const host = hostname.toLowerCase();
  const suffix = `.${base.toLowerCase()}`;
  return (
    host.endsWith(suffix) &&
    !host.slice(0, -suffix.length).includes(".") &&
    host.length > suffix.length
  );
}

/**
 * The apps application's destinations: the wildcard, with nothing let
 * through, then one per app with a public surface (public or bearer
 * routes) under the base domain, by host. Apps with neither need none (the
 * wildcard covers them).
 */
export function appsDestinations(
  appBaseDomain: string,
  apps: readonly AppPublicSurface[],
): {
  destinations: AccessPublicDestination[];
  dropped: DroppedRoute[];
  outsideBase: string[];
} {
  const destinations: AccessPublicDestination[] = [
    { type: "public", uri: appsWildcard(appBaseDomain), overrides: [] },
  ];
  const dropped: DroppedRoute[] = [];
  const outsideBase: string[] = [];
  for (const app of [...apps].sort((a, b) =>
    a.hostname.localeCompare(b.hostname),
  )) {
    if (!hasPublicSurface(app)) continue;
    if (!underBase(app.hostname, appBaseDomain)) {
      outsideBase.push(app.appId);
      continue;
    }
    const planned = appDestination(app);
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
export function isOwnedUri(
  uri: string | null | undefined,
  scope: AccessScope,
): boolean {
  const value = normalUri(uri);
  if (!value || value.includes("/")) return false;
  return (
    value === scope.gatewayHost.toLowerCase() ||
    value === appsWildcard(scope.appBaseDomain) ||
    underBase(value, scope.appBaseDomain)
  );
}

/** An application's destinations split into ours and everything else's. */
export function splitDestinations<
  T extends { uri?: string | null | undefined },
>(
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
const normalUri = (uri: string | null | undefined) =>
  (uri ?? "").toLowerCase().replace(/\/+$/, "");

function normalDestinations(
  destinations: ReadonlyArray<
    AccessDestinationOutput | AccessPublicDestination
  >,
) {
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
  return (
    JSON.stringify(normalDestinations(a)) ===
    JSON.stringify(normalDestinations(b))
  );
}

/** Whether the application has a public destination on exactly `uri`. */
function hasPublicDestination(
  application: AccessApplication,
  uri: string,
): boolean {
  return (
    application.type === "self_hosted" &&
    (application.destinations ?? []).some(
      (destination) =>
        (destination.type ?? "public") === "public" &&
        normalUri(destination.uri) === normalUri(uri),
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
  const own = applications.filter(
    (application) => !isAnotherGatewaysApplication(application, gatewayHost),
  );
  return {
    gateway:
      own.find((application) =>
        hasPublicDestination(application, gatewayHost),
      ) ?? null,
    apps:
      own.find((application) =>
        hasPublicDestination(application, appsWildcard(appBaseDomain)),
      ) ?? null,
  };
}

/** The shape of every Gateway's application names (lib/access/applications.ts `accessApplicationNames`). */
const GATEWAY_APPLICATION_NAME_PATTERN =
  /^Every App (gateway|apps)(?: \(([a-z0-9]{1,16})\))?$/;

/**
 * Whether an application is named as one of Every App's but covers another
 * Gateway's host as its own: its name's suffix (none for the default) isn't
 * the one this Gateway's host would carry. Judged by the host alone, since
 * the default Gateway's application and a named one's cover different
 * hosts; one whose primary destination is this very host is ours.
 */
function isAnotherGatewaysApplication(
  application: AccessApplication,
  gatewayHost: string,
): boolean {
  const match = GATEWAY_APPLICATION_NAME_PATTERN.exec(application.name ?? "");
  if (!match) return false;
  const domain = application["domain"];
  const primary =
    typeof domain === "string" ? domain.toLowerCase().replace(/\/.*$/, "") : "";
  if (!primary) return false;
  // Ours when its primary destination is this host or the apps' wildcard under it.
  return primary !== gatewayHost && primary !== appsWildcard(gatewayHost);
}

// --- The policy ---------------------------------------------------------

/**
 * The one rule of the policy in front of the Gateway and its apps: Access
 * asks the Gateway whether the person who just signed in is a member or
 * an invitee (External Evaluation), so the Gateway's list is the one list
 * both enforce, and an invitation needs no change in Access.
 */
export function externalEvaluationRule(gatewayHost: string): AccessRule {
  const origin = `https://${gatewayHost.toLowerCase()}`;
  return {
    external_evaluation: {
      evaluate_url: `${origin}${ACCESS_EVALUATION_PATHS.evaluate}`,
      keys_url: `${origin}${ACCESS_EVALUATION_PATHS.keys}`,
    },
  };
}

/** Whether two include lists say the same (order and case aside). */
export function sameRules(
  a: readonly AccessRule[],
  b: readonly AccessRule[],
): boolean {
  const key = (rule: AccessRule) =>
    JSON.stringify(rule, (_key, value: unknown) =>
      typeof value === "string" ? value.toLowerCase() : value,
    );
  return (
    JSON.stringify(a.map(key).sort()) === JSON.stringify(b.map(key).sort())
  );
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

/** A provider as the sign-in rules read it. */
interface SignInProvider {
  id: string;
  type: string;
  name?: string | null | undefined;
  config?:
    | { restrict_to_account_members?: boolean | null | undefined }
    | null
    | undefined;
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
    cloudflare: !providers.some(
      (provider) => provider.type === CLOUDFLARE_IDP_TYPE,
    ),
    pin: !providers.some((provider) => provider.type === ONE_TIME_PIN_IDP_TYPE),
  };
}

/**
 * The sign-in methods as a person reads them: "a Cloudflare account or a
 * one-time PIN", other providers by name ("a Cloudflare account, Okta or a
 * one-time PIN"). The Cloudflare account first, the PIN last.
 */
export function describeSignInMethods(
  providers: readonly SignInProvider[],
): string {
  const names = [
    ...(providers.some((provider) => provider.type === CLOUDFLARE_IDP_TYPE)
      ? ["a Cloudflare account"]
      : []),
    ...providers
      .filter(
        (provider) =>
          provider.type !== CLOUDFLARE_IDP_TYPE &&
          provider.type !== ONE_TIME_PIN_IDP_TYPE,
      )
      .map((provider) => provider.name ?? provider.type),
    ...(providers.some((provider) => provider.type === ONE_TIME_PIN_IDP_TYPE)
      ? ["a one-time PIN"]
      : []),
  ];
  return names.length <= 1
    ? (names[0] ?? "no sign-in method")
    : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
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
export function allowedSignInProviders<T extends SignInProvider>(
  providers: readonly T[],
): T[] {
  return providers.filter(
    (provider) =>
      provider.type === ONE_TIME_PIN_IDP_TYPE ||
      (provider.type === CLOUDFLARE_IDP_TYPE &&
        provider.config?.restrict_to_account_members === true),
  );
}
