/**
 * Scope sets for an `oauth_client` capability with a `scopePolicy`
 * (docs/capabilities.md "OAuth clients"): what an app's manifest entry
 * declares, what that lets the app ask the provider for, how each provider
 * spells what it granted, and which API routes a set unlocks. Pure
 * functions over the registry, shared by the gateway's token-endpoint
 * check, the SDK's local-dev twin of it and, later, the proxy and the
 * outbound Worker. Nothing here reads a secret or a token value.
 */
import type {
  OAuthScopeDialect,
  OAuthScopePolicy,
  OAuthScopeSet,
} from "./capabilities.js";
import type { TokenRequest } from "./oauthClient.js";

/** Scopes by the token they belong to: the bot or only token, and Slack's user token. */
export interface ScopeList {
  scopes: string[];
  userScopes: string[];
}

/** What a token response says it granted; a field is present when that kind of token is. */
export interface GrantedScopes {
  scopes?: string[];
  userScopes?: string[];
}

/**
 * The scope set names a manifest entry declares, or null when the entry
 * voids its grant: `scopes` missing, not an array, empty, a non-string
 * element, a name listed twice, or any name the policy doesn't offer. An
 * unknown name voids the whole grant rather than narrowing it silently, so
 * a newer CLI's set name reaching an older gateway is refused outright and
 * a message can say so.
 */
export function declaredScopeSets(
  policy: OAuthScopePolicy,
  entry: { scopes?: unknown } | undefined,
): string[] | null {
  const declared = entry?.scopes;
  if (!Array.isArray(declared) || declared.length === 0) return null;
  const names: string[] = [];
  for (const name of declared) {
    if (
      typeof name !== "string" ||
      !Object.hasOwn(policy.sets, name) ||
      names.includes(name)
    ) {
      return null;
    }
    names.push(name);
  }
  return names;
}

/**
 * What an app with `sets` asks the provider for: the sets' scopes in
 * registry order, deduplicated, then `alwaysRequested`. The status hands
 * these out and the authorize URL (Microsoft: the token leg too) carries
 * them verbatim.
 */
export function requestedScopes(
  policy: OAuthScopePolicy,
  sets: readonly string[],
): ScopeList {
  const scopes: string[] = [];
  const userScopes: string[] = [];
  for (const [, set] of setsOf(policy, sets)) {
    pushNew(scopes, set.scopes);
    pushNew(userScopes, set.userScopes ?? []);
  }
  pushNew(scopes, policy.alwaysRequested);
  return { scopes, userScopes };
}

/**
 * What a token an app with `sets` is handed may carry: the requested
 * scopes and the tolerated ones, in the dialect's canonical spelling so a
 * granted list canonicalised the same way compares exactly.
 */
export function allowedScopes(
  policy: OAuthScopePolicy,
  sets: readonly string[],
): ScopeList {
  const requested = requestedScopes(policy, sets);
  return {
    scopes: canonical(policy.dialect, [
      ...requested.scopes,
      ...policy.tolerated,
    ]),
    userScopes: canonical(policy.dialect, requested.userScopes),
  };
}

/**
 * Whether a token response body carries a token: an access, refresh or ID
 * token, or Slack's user token under `authed_user`. A 2xx without one
 * (Slack's `ok: false`) is an error the app must see, not a grant.
 */
export function carriesToken(json: unknown): boolean {
  const body = record(json);
  if (!body) return false;
  return (
    typeof body["access_token"] === "string" ||
    typeof body["refresh_token"] === "string" ||
    typeof body["id_token"] === "string" ||
    typeof record(body["authed_user"])?.["access_token"] === "string"
  );
}

/**
 * The scopes a token response says it granted, canonicalised per dialect,
 * or null when the answer names none for a token it carries, which fails
 * closed: every documented success response of the three providers names
 * them (map-providers: Google and Microsoft `scope`, Slack `scope` and
 * `authed_user.scope`), so a missing field is an answer the gateway can't
 * hold to anything.
 */
export function grantedScopes(
  policy: OAuthScopePolicy,
  json: unknown,
): GrantedScopes | null {
  const body = record(json);
  if (!body) return null;
  switch (policy.dialect) {
    case "google": {
      // Space-delimited, case-sensitive strings (Google's own words).
      const scopes = splitScopes("google", body["scope"]);
      return scopes ? { scopes } : null;
    }
    case "microsoft": {
      // Documented URL-encoded with the Graph prefix
      // (`https%3A%2F%2Fgraph.microsoft.com%2Fmail.read`), seen as short
      // names in either case; `offline_access` is never echoed, and dropped
      // if it ever is.
      if (typeof body["scope"] !== "string") return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(body["scope"]);
      } catch {
        return null;
      }
      const scopes = splitScopes("microsoft", decoded)?.filter(
        (scope) => scope !== "offline_access",
      );
      return scopes && scopes.length > 0 ? { scopes } : null;
    }
    case "slack":
      return slackGrantedScopes(body);
    case "space":
    case "comma": {
      const scopes = splitScopes(policy.dialect, body["scope"]);
      return scopes ? { scopes } : null;
    }
  }
}

/**
 * What a token response granted, for the Gateway-owned flow: as
 * {@link grantedScopes}, except that a `space` or `comma` provider that
 * names no `scope` at all is taken at its word (RFC 6749 §5.1: the field
 * is optional when the grant matches the request), so `requested` stands.
 * The three parsed dialects keep failing closed.
 */
export function grantedScopesOrRequested(
  policy: OAuthScopePolicy,
  json: unknown,
  requested: ScopeList,
): GrantedScopes | null {
  const granted = grantedScopes(policy, json);
  if (granted) return granted;
  const body = record(json);
  if (
    body &&
    body["scope"] === undefined &&
    (policy.dialect === "space" || policy.dialect === "comma")
  ) {
    return { scopes: canonical(policy.dialect, requested.scopes) };
  }
  return null;
}

/** Why the proxy refuses a held-token call, with what would let it through. */
export type HeldTokenRefusal =
  | {
      ok: false;
      code: "integration_not_connected";
      /** The declared sets the connection was not granted. */
      missingSets: string[];
    }
  | {
      ok: false;
      code: "integration_scope_not_allowed" | "integration_method_not_allowed";
      message: string;
    };

/**
 * Whether an app's call with a held token goes through, and under which
 * set (docs/design/2026-10-oauth-providers.md section 7). In order: every
 * set the app declares must be among the connection's (else the person
 * connects again: `integration_not_connected` with the missing sets); the
 * host must be one of the provider's `api` hosts; the path passes the
 * segment rules (`scopeRouteAllows`'s: no batch tunnels, no dot segments,
 * no denied segments); then a declared set with routes must cover the
 * call, or a declared set without routes covers its hosts by access: a
 * read set unlocks `readMethods` (GET and HEAD by default), a write set
 * every method the provider offers. `writes` says whether the method is
 * one the grant allows beyond reads, decided by the caller as for an
 * API-key provider.
 */
export function heldTokenCallAllowed({
  policy,
  declaredSets,
  connectionSets,
  hosts,
  method,
  upstream,
  readMethods = ["GET", "HEAD"],
  writes,
}: {
  policy: OAuthScopePolicy;
  declaredSets: readonly string[];
  connectionSets: readonly string[];
  /** The provider's `api` hosts. */
  hosts: readonly string[];
  method: string;
  upstream: URL;
  readMethods?: readonly string[];
  /** Whether `method` is a write the app's grant allows. */
  writes: boolean;
}): { ok: true; set: string } | HeldTokenRefusal {
  const missingSets = declaredSets.filter(
    (name) => !connectionSets.includes(name),
  );
  if (missingSets.length > 0) {
    return { ok: false, code: "integration_not_connected", missingSets };
  }
  if (upstream.protocol !== "https:" || !hosts.includes(upstream.host)) {
    return {
      ok: false,
      code: "integration_scope_not_allowed",
      message: `${upstream.host} is not a host this provider's token reaches (${hosts.join(", ")}).`,
    };
  }
  if (!safeSegments(policy, upstream.pathname)) {
    return {
      ok: false,
      code: "integration_scope_not_allowed",
      message: `${upstream.pathname} is a path no scope set unlocks.`,
    };
  }
  const verb = method.toUpperCase();
  const reads = readMethods.includes(verb);
  // A set's routes decide first: a read-shaped POST a read set lists
  // under `posts` (a search, a query) is a read whatever the grant.
  const routed = scopeRouteAllows(policy, declaredSets, verb, upstream);
  if (routed) return { ok: true, set: routed };
  if (!reads && !writes) {
    return {
      ok: false,
      code: "integration_method_not_allowed",
      message: `${verb} ${upstream.pathname}: calls may use ${readMethods.join(" or ")} with access: "read"; ${verb} needs access: "write" in the app's capabilities entry, on a provider that offers it, or a scope set whose routes list it.`,
    };
  }
  for (const [name, set] of setsOf(policy, declaredSets)) {
    if (set.routes.length > 0) continue;
    if (reads || (writes && set.access === "write")) {
      return { ok: true, set: name };
    }
  }
  return {
    ok: false,
    code: "integration_scope_not_allowed",
    message: `${verb} ${upstream.pathname} is outside the scope sets this app declares (${declaredSets.join(", ")}).`,
  };
}

/**
 * Slack answers with up to two tokens, each with its own scopes: the bot
 * token at the top level and the installing person's under `authed_user`.
 * Which kind the top-level one is comes from `token_type`, because a
 * token-rotation refresh of a user token comes back at the top level with
 * `token_type: "user"`; `authed_user` is a user token unless it says so.
 */
function slackGrantedScopes(
  body: Record<string, unknown>,
): GrantedScopes | null {
  const granted: GrantedScopes = {};
  const take = (token: Record<string, unknown>, kind: unknown): boolean => {
    if (kind !== "bot" && kind !== "user") return false;
    const scopes = splitScopes("slack", token["scope"]);
    if (!scopes) return false;
    const key = kind === "bot" ? "scopes" : "userScopes";
    granted[key] = pushNew(granted[key] ?? [], scopes);
    return true;
  };
  if (typeof body["access_token"] === "string") {
    if (!take(body, body["token_type"])) return null;
  }
  const authedUser = record(body["authed_user"]);
  if (authedUser && typeof authedUser["access_token"] === "string") {
    if (!take(authedUser, authedUser["token_type"] ?? "user")) return null;
  }
  return granted.scopes || granted.userScopes ? granted : null;
}

/**
 * What `granted` carries beyond `allowed`, per token kind, for a refusal's
 * message and log line: the user token's extras as `user:<scope>`. Both
 * lists are in the dialect's canonical spelling already.
 */
export function scopeExcess(
  granted: GrantedScopes,
  allowed: ScopeList,
): string[] {
  const extra = (scopes: string[] | undefined, within: string[]) =>
    (scopes ?? []).filter((scope) => !within.includes(scope));
  return [
    ...extra(granted.scopes, allowed.scopes),
    ...extra(granted.userScopes, allowed.userScopes).map(
      (scope) => `user:${scope}`,
    ),
  ];
}

/**
 * The scopes a token request itself asks for (`scope`, and Slack's
 * `user_scope`, in any case) in its form or JSON body, canonicalised per
 * dialect for comparison with `allowedScopes()`, or null when the body
 * names none. The query string is never read: the gateway refuses a
 * request that puts these there, so only one place decides.
 */
export function requestedTokenScopes(
  policy: OAuthScopePolicy,
  request: TokenRequest,
): GrantedScopes | null {
  const fields = bodyFields(request);
  if (!fields) return null;
  const requested: GrantedScopes = {};
  const scopes = splitScopes(policy.dialect, fields["scope"]);
  if (scopes) requested.scopes = scopes;
  const userScopes = splitScopes(policy.dialect, fields["user_scope"]);
  if (userScopes) requested.userScopes = userScopes;
  return requested.scopes || requested.userScopes ? requested : null;
}

/**
 * `request` with its `scope`, in any case, as the policy's `requestScope`
 * says: replaced by the requested list of the app's `sets`, dropped, or
 * kept as sent. A separate step after `injectClientCredentials()`, whose
 * re-serialised form or JSON body this edits the same way; any other body
 * is left alone.
 */
export function rewriteTokenRequestScope(
  policy: OAuthScopePolicy,
  sets: readonly string[],
  request: TokenRequest,
): TokenRequest {
  if (policy.requestScope === "keep" || !request.body) return request;
  const replacement =
    policy.requestScope === "replace"
      ? requestedScopes(policy, sets).scopes.join(" ")
      : null;
  const type = mediaType(request.headers.get("content-type"));
  // Every spelling goes, as `injectClientCredentials()` strips the client:
  // Entra reads a form's names in any case, so a `Scope` left beside the
  // gateway's `scope` is refused upstream as a duplicate, or read instead.
  const isScope = (name: string) => name.toLowerCase() === "scope";
  let body = request.body;
  if (type === FORM) {
    const params = new URLSearchParams(body);
    for (const name of new Set([...params.keys()].filter(isScope))) {
      params.delete(name);
    }
    if (replacement !== null) params.set("scope", replacement);
    body = params.toString();
  } else if (type === JSON_TYPE) {
    const parsed = jsonObject(body);
    if (!parsed) return request;
    for (const name of Object.keys(parsed)) {
      if (isScope(name)) delete parsed[name];
    }
    if (replacement !== null) parsed["scope"] = replacement;
    body = JSON.stringify(parsed);
  } else {
    return request;
  }
  return { url: request.url, headers: request.headers, body };
}

/**
 * The declared set that unlocks `method upstream`, or null. Not wired to
 * any live path yet: it becomes the proxy's boundary once the gateway
 * holds tokens, and the outbound Worker's for dispatched apps before that.
 *
 * In order: https only; the host must be on one of the declared sets'
 * routes; the raw pathname is refused when it holds `\`, `//` or `%00`;
 * each raw segment, and each percent-decoding of it while a `%` remains
 * (a provider's layers may each decode once), is refused when it won't
 * decode, holds a control or format character or a backslash, is one of
 * the policy's denied segments in any case, or splits on `/` into a dot
 * segment: `.` or `..`, with or without a `;` parameter (`..;x`), which
 * Google's front end resolves like the bare one. The denied comparison is
 * of the whole segment, because an encoded slash is part of one id to the
 * provider, never a separator: a Search Console site URL whose own path
 * holds `batch` stays matchable, and `2%2FmeasurementProtocolSecrets` is
 * a data stream id that doesn't exist, not the secrets. Then the raw
 * pathname, case preserved, is matched: GET and HEAD need a `paths` entry
 * (exact, or a prefix when it ends in `/`), POST needs a `posts` pattern,
 * and no other method goes through. Matching the raw path is what lets
 * Search Console's `sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query`
 * match `[^/]+` while `..`, batch tunnels and secrets stay refused however
 * encoded. `X-HTTP-Method-Override`, `access_token` and `token` parameters
 * are the proxy's to strip before it asks; nothing here reads them. The
 * proxy fetches with `redirect: "manual"`: Google answers a dot segment it
 * resolves with a 302 to the resolved path, and following one would carry
 * the token to a path this never matched.
 */
export function scopeRouteAllows(
  policy: OAuthScopePolicy,
  sets: readonly string[],
  method: string,
  upstream: URL,
): string | null {
  if (upstream.protocol !== "https:") return null;
  const onHost = setsOf(policy, sets).flatMap(([name, set]) =>
    set.routes
      .filter((route) => route.host === upstream.host)
      .map((route) => [name, route] as const),
  );
  if (onHost.length === 0) return null;
  const pathname = upstream.pathname;
  if (!safeSegments(policy, pathname)) return null;
  const verb = method.toUpperCase();
  for (const [name, route] of onHost) {
    if (verb === "GET" || verb === "HEAD") {
      const covered = route.paths.some((entry) =>
        entry.endsWith("/") ? pathname.startsWith(entry) : pathname === entry,
      );
      if (covered) return name;
    } else if (verb === "POST") {
      if (route.posts?.some((pattern) => pattern.test(pathname))) return name;
    }
  }
  return null;
}

/** Control and format characters: in no provider's path once decoded. */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;
/** A dot segment, bare or with a path parameter (`..;x`): Google's front end resolves both. */
const DOT_SEGMENT = /^\.{1,2}(;|$)/;

/**
 * Whether every segment of the raw `pathname` passes the checks above in
 * each form a provider's layers could see it: raw, then decoded again
 * while a `%` remains.
 */
function safeSegments(policy: OAuthScopePolicy, pathname: string): boolean {
  if (
    pathname.includes("\\") ||
    pathname.includes("//") ||
    pathname.includes("%00")
  ) {
    return false;
  }
  const denied = policy.deniedSegments.map((segment) => segment.toLowerCase());
  for (const raw of pathname.split("/")) {
    let text = raw;
    for (;;) {
      if (!safeSegment(text, denied)) return false;
      if (!text.includes("%")) break;
      // A `%` left after a decode is a byte the provider may decode again
      // (double encoding), so that form is checked too; one that isn't an
      // escape (`%2525` ends in a bare `%`) won't decode and refuses, as a
      // malformed escape in the raw path does.
      try {
        text = decodeURIComponent(text);
      } catch {
        return false;
      }
    }
  }
  return true;
}

/**
 * Whether one form of a segment is safe: no control or format character,
 * no backslash (in no provider's grammar), not a denied segment in any
 * case, and no dot segment among its `/`-split parts (a traversal the
 * provider might resolve). The denied comparison is of the whole: an
 * encoded slash is part of one id to the provider, never a separator, so
 * a Search Console site URL whose own path holds `batch` stays matchable.
 */
function safeSegment(text: string, denied: readonly string[]): boolean {
  if (UNPRINTABLE.test(text) || text.includes("\\")) return false;
  if (denied.includes(text.toLowerCase())) return false;
  return !text.split("/").some((part) => DOT_SEGMENT.test(part));
}

/** The policy's sets in registry order, keeping those `names` declares. */
function setsOf(
  policy: OAuthScopePolicy,
  names: readonly string[],
): [string, OAuthScopeSet][] {
  return Object.entries(policy.sets).filter(([name]) => names.includes(name));
}

const GOOGLE_ALIASES = new Map([
  ["email", "https://www.googleapis.com/auth/userinfo.email"],
  ["profile", "https://www.googleapis.com/auth/userinfo.profile"],
]);
const GRAPH_PREFIX = /^https:\/\/graph\.microsoft\.com\//i;

/** `scopes` in the dialect's one spelling, deduplicated, order kept. */
function canonical(dialect: OAuthScopeDialect, scopes: string[]): string[] {
  return pushNew(
    [],
    scopes.map((scope) => {
      switch (dialect) {
        case "google":
          return GOOGLE_ALIASES.get(scope) ?? scope;
        case "microsoft":
          return scope.replace(GRAPH_PREFIX, "").toLowerCase();
        case "slack":
        case "space":
        case "comma":
          return scope;
      }
    }),
  );
}

/**
 * A provider's scope field split into scopes, canonicalised, or null when
 * it isn't a string or names nothing. Google and Microsoft separate with
 * spaces; Slack with commas (spaces too, in its legacy form).
 */
function splitScopes(
  dialect: OAuthScopeDialect,
  value: unknown,
): string[] | null {
  if (typeof value !== "string") return null;
  const separator =
    dialect === "slack" || dialect === "comma" ? /[,\s]+/ : /\s+/;
  const scopes = canonical(dialect, value.split(separator).filter(Boolean));
  return scopes.length > 0 ? scopes : null;
}

/** `into` with each of `more` it doesn't have yet, in order. */
function pushNew(into: string[], more: readonly string[]): string[] {
  for (const item of more) if (!into.includes(item)) into.push(item);
  return into;
}

const FORM = "application/x-www-form-urlencoded";
const JSON_TYPE = "application/json";

/** A token request's body fields, form or JSON, by lowercased name; null for any other body. */
function bodyFields(request: TokenRequest): Record<string, unknown> | null {
  if (!request.body) return null;
  const type = mediaType(request.headers.get("content-type"));
  if (type === FORM) return foldFields(new URLSearchParams(request.body));
  if (type === JSON_TYPE) {
    const parsed = jsonObject(request.body);
    return parsed && foldFields(Object.entries(parsed));
  }
  return null;
}

/**
 * `pairs` by lowercased name, as Entra reads a form's names in any case. A
 * name's values are one space-joined list, so a field sent twice, or as
 * `scope` and `Scope`, hides nothing in the second copy; a value that
 * isn't a string leaves its field not a string, which reads as naming
 * none.
 */
function foldFields(
  pairs: Iterable<[string, unknown]>,
): Record<string, unknown> {
  const fields = new Map<string, unknown>();
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    const before = fields.get(key);
    fields.set(
      key,
      !fields.has(key)
        ? value
        : typeof before === "string" && typeof value === "string"
          ? `${before} ${value}`
          : [before, value],
    );
  }
  return Object.fromEntries(fields);
}

/** A Content-Type's media type, lowercased and without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * `text` as a JSON object, or null for anything else (an array, a scalar,
 * not JSON). Shared with the gateway's read of a provider's token answer.
 */
export function jsonObject(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
