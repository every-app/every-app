/**
 * The Gateway-owned OAuth flow (docs/design/2026-10-oauth-providers.md
 * section 5), on the gateway host, for a signed-in member:
 *
 *   GET /connect/<id>?account=user|organization&return=…&sets=a,b
 *     → 302 to the provider's authorize URL (PKCE S256, a one-use state)
 *   GET /connect/<id>/callback?code&state      ← the redirect URI registered
 *     → the code exchanged, the connection stored sealed, 302 to `return`
 *
 * A provider's `error`, a bad state or a refused scope ends on a Gateway
 * page, never a redirect. Logs name the provider, the organization, the
 * account kind and scope-set names; never a code, a token, the client, the
 * verifier or the state.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  OAUTH_TOKEN_BODY_LIMIT,
  allowedScopes,
  canonicalScopes,
  grantedScopesOrRequested,
  requestedScopes,
  scopeExcess,
  type OAuthClientCapability,
  type OAuthScopePolicy,
} from "@every-app/sdk/internal";
import { auth as betterAuth } from "@/auth";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import {
  resolveOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OAuthStateRepository } from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { isUserBanned } from "@/server/user-ban";
import { resolveOAuthClient, type OAuthClientResolver } from "./client";
import { errorPage } from "./page";
import { redirectUriFor } from "./service";
import { flowOf, tokenCall, type Fetch } from "./tokens";

const CONNECT_PREFIX = "/connect/";
/** Where the browser lands after a connect with no `return`. */
export const DEFAULT_RETURN = "/settings/accounts";
/** How long a state row lives. */
const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
const SET_NAME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)?$/;

interface ConnectRouteDeps {
  fetchUpstream?: Fetch;
  resolveClient?: OAuthClientResolver;
  now?: () => number;
}

type ConnectEnv = typeof env & {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
};

function settings(): ConnectEnv {
  return env as ConnectEnv;
}

/** Which route a path is: the start, the callback, or neither. */
function parseConnectPath(
  pathname: string,
): { id: string; kind: "start" | "callback" } | null {
  if (!pathname.startsWith(CONNECT_PREFIX)) return null;
  const rest = pathname.slice(CONNECT_PREFIX.length);
  const match = /^([^/]+)(\/callback)?\/?$/.exec(rest);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!PROVIDER_ID.test(id)) return null;
  return { id, kind: match[2] ? "callback" : "start" };
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}

const CANT_CONNECT = "Can't connect this account";

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

async function signedIn(
  request: Request,
): Promise<{ id: string; email: string; org: OrgContext } | null> {
  const session = await betterAuth.api.getSession({ headers: request.headers });
  if (!session?.user?.id || isUserBanned(session.user)) return null;
  const org = await resolveOrgContext({
    userId: session.user.id,
    activeOrganizationId: session.session.activeOrganizationId ?? null,
  });
  if (!org) return null;
  return { id: session.user.id, email: session.user.email, org };
}

/** The gateway's own origin, from GATEWAY_URL; null when unset or unparsable. */
function ownOrigin(): URL | null {
  try {
    const raw = settings().GATEWAY_URL;
    return raw ? new URL(raw) : null;
  } catch {
    return null;
  }
}

function underDomain(host: string, domain: string | undefined): boolean {
  const base = domain?.trim().toLowerCase().replace(/\.$/, "");
  if (!base) return false;
  return host === base || host.endsWith(`.${base}`);
}

/**
 * Where a connect may send the browser afterwards
 * (`oauth.return-to-own-hosts`): a path on the gateway, an https URL on
 * one of this gateway's hosts (the gateway's own, an app host under
 * APP_BASE_DOMAIN, a host under THIRD_PARTY_DOMAIN), or when the gateway
 * itself runs on http://localhost, any localhost URL. Anything else is
 * replaced by the default.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return DEFAULT_RETURN;
  const text = raw.trim();
  if (
    text.startsWith("/") &&
    !text.startsWith("//") &&
    !text.startsWith("/\\")
  ) {
    return text;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return DEFAULT_RETURN;
  }
  const own = ownOrigin();
  const host = url.hostname.toLowerCase();
  const dev =
    own !== null &&
    own.protocol === "http:" &&
    (own.hostname === "localhost" || own.hostname === "127.0.0.1");
  if (dev && (host === "localhost" || host === "127.0.0.1")) return url.href;
  if (url.protocol !== "https:") return DEFAULT_RETURN;
  if (own && own.hostname.toLowerCase() === host) return url.href;
  const { APP_BASE_DOMAIN, THIRD_PARTY_DOMAIN } = settings();
  if (
    underDomain(host, APP_BASE_DOMAIN) ||
    underDomain(host, THIRD_PARTY_DOMAIN)
  ) {
    return url.href;
  }
  return DEFAULT_RETURN;
}

/** A capability's scope sets by name, `[]` when it has no policy. */
function setNames(capability: OAuthClientCapability): string[] {
  return Object.keys(capability.scopePolicy?.sets ?? {});
}

/**
 * The scope sets a connect asks for: the ones named, else the union of
 * what every active app that lists the provider declares, else every set;
 * `identity` always when the provider has it. Null when a named set
 * doesn't exist.
 */
async function setsToAsk(
  id: string,
  capability: OAuthClientCapability,
  named: readonly string[] | null,
): Promise<string[] | null> {
  const all = setNames(capability);
  if (all.length === 0) return [];
  const chosen = new Set<string>();
  if (named && named.length > 0) {
    for (const name of named) {
      if (!all.includes(name)) return null;
      chosen.add(name);
    }
  } else {
    for (const app of await AppRepository.findAllManifests()) {
      const manifest = parseManifest(app.manifest);
      const entry = manifest?.["capabilities"];
      if (!entry || typeof entry !== "object") continue;
      const listed = (entry as Record<string, unknown>)[id];
      if (!listed || typeof listed !== "object") continue;
      const scopes = (listed as Record<string, unknown>)["scopes"];
      if (!Array.isArray(scopes)) continue;
      for (const name of scopes) {
        if (typeof name === "string" && all.includes(name)) chosen.add(name);
      }
    }
    if (chosen.size === 0) for (const name of all) chosen.add(name);
  }
  if (all.includes("identity")) chosen.add("identity");
  return all.filter((name) => chosen.has(name));
}

function parseManifest(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The scope strings to put on the authorize URL for `sets`. */
function scopesFor(
  capability: OAuthClientCapability,
  sets: readonly string[],
): { scopes: string[]; userScopes: string[] } {
  const policy = capability.scopePolicy;
  if (!policy) {
    return { scopes: [...capability.authorize.scopes], userScopes: [] };
  }
  const requested = requestedScopes(policy, sets);
  return { scopes: requested.scopes, userScopes: requested.userScopes };
}

function joinScopes(
  capability: OAuthClientCapability,
  scopes: readonly string[],
): string {
  const dialect = flowOf(capability)?.scopeDialect ?? "space";
  return scopes.join(dialect === "comma" ? "," : " ");
}

/**
 * Which of the asked sets the provider granted whole, from the token
 * answer's scopes (or, for a provider that doesn't say, all of them).
 * Null when the answer is one the dialect can't read, or carries scopes
 * beyond what the sets and the tolerated list allow.
 */
export function grantedSets(
  policy: OAuthScopePolicy,
  body: Record<string, unknown>,
  sets: readonly string[],
):
  | { sets: string[]; scopes: string[] }
  | { refused: "unverified" | "excess"; excess?: string[] } {
  const requested = requestedScopes(policy, sets);
  const granted = grantedScopesOrRequested(policy, body, requested);
  if (!granted) return { refused: "unverified" };
  const excess = scopeExcess(granted, allowedScopes(policy, sets));
  if (excess.length > 0) return { refused: "excess", excess };
  const has = (list: readonly string[] | undefined, scope: string) =>
    (list ?? []).includes(scope);
  // A set is granted whole when each of its scopes, in the dialect's
  // canonical spelling (Google answers long names), was granted.
  const kept = sets.filter((name) => {
    const set = policy.sets[name];
    if (!set) return false;
    return (
      canonicalScopes(policy.dialect, set.scopes).every((scope) =>
        has(granted.scopes, scope),
      ) &&
      canonicalScopes(policy.dialect, set.userScopes ?? []).every((scope) =>
        has(granted.userScopes, scope),
      )
    );
  });
  return {
    sets: kept,
    scopes: [...(granted.scopes ?? []), ...(granted.userScopes ?? [])],
  };
}

/** A dot path into a JSON value. */
function dotPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

async function readIdentity(
  capability: OAuthClientCapability,
  accessToken: string,
  fetchUpstream: Fetch,
  log: Record<string, unknown>,
): Promise<{ label: string | null; externalId: string | null }> {
  const identity = flowOf(capability)?.identity;
  if (!identity) return { label: null, externalId: null };
  try {
    const response = await fetchUpstream(
      new Request(identity.url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        redirect: "manual",
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      logEvent(
        "oauth.identity_refused",
        { ...log, status: response.status },
        "warn",
      );
      return { label: null, externalId: null };
    }
    const text = await response.text();
    if (text.length > OAUTH_TOKEN_BODY_LIMIT)
      return { label: null, externalId: null };
    const body: unknown = JSON.parse(text);
    const label = dotPath(body, identity.label);
    const id = identity.id ? dotPath(body, identity.id) : undefined;
    const asText = (value: unknown): string | null =>
      typeof value === "string"
        ? value.slice(0, 200)
        : typeof value === "number"
          ? String(value)
          : null;
    return { label: asText(label), externalId: asText(id) };
  } catch (error) {
    logEvent(
      "oauth.identity_failed",
      { ...log, error: error instanceof Error ? error.name : "unknown" },
      "warn",
    );
    return { label: null, externalId: null };
  }
}

async function serveStart(
  request: Request,
  id: string,
  deps: ConnectRouteDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const person = await signedIn(request);
  if (!person) {
    const back = `${url.pathname}${url.search}`;
    return redirect(`/sign-in?redirect=${encodeURIComponent(back)}`);
  }
  const accountRaw = url.searchParams.get("account") ?? "user";
  if (accountRaw !== "user" && accountRaw !== "organization") {
    return errorPage(
      400,
      CANT_CONNECT,
      "account must be user or organization.",
    );
  }
  const account = accountRaw;
  if (account === "organization" && person.org.role === "member") {
    return errorPage(
      403,
      CANT_CONNECT,
      "Only an owner or admin can connect the organization's account.",
    );
  }
  const registry = await gatewayProviders();
  const capability = registry.get(id);
  if (!capability || capability.mode !== "oauth_client") {
    return errorPage(
      404,
      CANT_CONNECT,
      `No OAuth provider ${id} is on this Gateway.`,
    );
  }
  const flow = flowOf(capability);
  if (!flow) {
    return errorPage(
      409,
      CANT_CONNECT,
      `${capability.label} is connected from inside an app, not here.`,
    );
  }
  const client = await (deps.resolveClient ?? resolveOAuthClient)({
    id,
    capability,
    env: settings() as never,
    lookup: registry,
  });
  if (!client) {
    return errorPage(
      409,
      CANT_CONNECT,
      `${capability.label} has no client on this Gateway yet. An owner or admin adds one under Manage workspace → Providers.`,
    );
  }
  const namedRaw = url.searchParams.get("sets");
  const named = namedRaw
    ? namedRaw
        .split(",")
        .map((each) => each.trim())
        .filter(Boolean)
    : null;
  if (named?.some((name) => !SET_NAME.test(name))) {
    return errorPage(
      400,
      CANT_CONNECT,
      "sets names a scope set that doesn't exist.",
    );
  }
  const sets = await setsToAsk(id, capability, named);
  if (sets === null) {
    return errorPage(
      400,
      CANT_CONNECT,
      "sets names a scope set that doesn't exist.",
    );
  }
  const returnTo = safeReturnTo(url.searchParams.get("return"));
  const state = randomToken(32);
  const verifier = randomToken(48);
  const now = (deps.now ?? Date.now)();
  await OAuthStateRepository.put({
    state,
    providerId: id,
    organizationId: person.org.orgId,
    userId: person.id,
    accountKind: account,
    codeVerifier: verifier,
    scopeSets: sets,
    returnTo,
    now: new Date(now),
    ttlMs: STATE_TTL_MS,
  });
  const authorize = new URL(capability.authorize.url);
  const { scopes, userScopes } = scopesFor(capability, sets);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", redirectUriFor(id, settings()));
  if (scopes.length > 0) {
    authorize.searchParams.set("scope", joinScopes(capability, scopes));
  }
  if (userScopes.length > 0) {
    authorize.searchParams.set(
      "user_scope",
      joinScopes(capability, userScopes),
    );
  }
  authorize.searchParams.set("state", state);
  if (flow.pkce) {
    authorize.searchParams.set("code_challenge", await s256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
  }
  for (const [name, value] of Object.entries(flow.authorizeParams ?? {})) {
    authorize.searchParams.set(name, value);
  }
  logEvent("oauth.connect_started", {
    provider: id,
    org: person.org.orgId,
    user_id: person.id,
    account,
    scopeSets: sets,
  });
  return redirect(authorize.toString());
}

async function serveCallback(
  request: Request,
  id: string,
  deps: ConnectRouteDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const person = await signedIn(request);
  if (!person) {
    return errorPage(
      401,
      CANT_CONNECT,
      "Sign in to the Gateway in this browser, then connect again.",
    );
  }
  const fetchUpstream = deps.fetchUpstream ?? ((req) => fetch(req));
  const now = (deps.now ?? Date.now)();
  const log = {
    provider: id,
    org: person.org.orgId,
    user_id: person.id,
  };
  const stateParam = url.searchParams.get("state");
  // The state row goes first and is spent whatever follows
  // (`oauth.state-single-use`), including a provider error.
  const state = stateParam
    ? await OAuthStateRepository.take(stateParam, new Date(now))
    : null;
  if (!state || state.providerId !== id) {
    logEvent("oauth.callback_refused", { ...log, reason: "state" }, "warn");
    return errorPage(
      400,
      CANT_CONNECT,
      "This connect link was used already, expired, or didn't start here. Start again.",
    );
  }
  if (state.userId !== person.id || state.organizationId !== person.org.orgId) {
    logEvent(
      "oauth.callback_refused",
      { ...log, reason: "foreign_state" },
      "warn",
    );
    return errorPage(
      400,
      CANT_CONNECT,
      "This connect was started by someone else, or in another organization. Start again.",
    );
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    logEvent(
      "oauth.callback_refused",
      { ...log, reason: "provider_error", error: providerError.slice(0, 64) },
      "warn",
    );
    return errorPage(
      400,
      CANT_CONNECT,
      providerError === "access_denied"
        ? "The provider says you declined. Nothing was connected."
        : `The provider refused: ${providerError.slice(0, 64)}. Nothing was connected.`,
    );
  }
  const code = url.searchParams.get("code");
  if (!code) {
    logEvent("oauth.callback_refused", { ...log, reason: "no_code" }, "warn");
    return errorPage(
      400,
      CANT_CONNECT,
      "The provider sent no code. Start again.",
    );
  }
  const registry = await gatewayProviders();
  const capability = registry.get(id);
  if (
    !capability ||
    capability.mode !== "oauth_client" ||
    !flowOf(capability)
  ) {
    return errorPage(
      404,
      CANT_CONNECT,
      `No OAuth provider ${id} is on this Gateway.`,
    );
  }
  const flow = flowOf(capability)!;
  const client = await (deps.resolveClient ?? resolveOAuthClient)({
    id,
    capability,
    env: settings() as never,
    lookup: registry,
  });
  if (!client) {
    return errorPage(
      409,
      CANT_CONNECT,
      `${capability.label} has no client on this Gateway.`,
    );
  }
  const exchanged = await tokenCall({
    capability,
    client,
    fields: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUriFor(id, settings()),
      ...(flow.pkce ? { code_verifier: state.codeVerifier } : {}),
    },
    fetchUpstream,
    now,
    log: { provider: id, org: person.org.orgId, grant: "authorization_code" },
  });
  if (!exchanged.ok) {
    return errorPage(
      502,
      CANT_CONNECT,
      `${capability.label} didn't accept the code (${exchanged.error}). Start again.`,
    );
  }
  const policy = capability.scopePolicy;
  let sets = state.scopeSets;
  let scopes: string[] = [...capability.authorize.scopes];
  if (policy) {
    const outcome = grantedSets(policy, exchanged.tokens.body, state.scopeSets);
    if ("refused" in outcome) {
      // The tokens are dropped here: never stored, forwarded or logged.
      logEvent(
        "oauth.callback_refused",
        {
          ...log,
          reason: `scope_${outcome.refused}`,
          scopeSets: state.scopeSets,
        },
        "warn",
      );
      return errorPage(
        400,
        CANT_CONNECT,
        outcome.refused === "excess"
          ? `${capability.label} granted more than was asked (${outcome.excess?.join(", ")}); nothing was kept. Check the client's allowed scopes at its console.`
          : `${capability.label} didn't say which scopes it granted; nothing was kept.`,
      );
    }
    sets = outcome.sets;
    scopes = outcome.scopes;
  }
  const identity = await readIdentity(
    capability,
    exchanged.tokens.accessToken,
    fetchUpstream,
    log,
  );
  const existing = await ProviderConnectionRepository.find(
    person.org.orgId,
    id,
    state.accountKind === "user" ? person.id : "organization",
  );
  await ProviderConnectionRepository.upsert(
    {
      organizationId: person.org.orgId,
      providerId: id,
      accountKind: state.accountKind,
      userId: state.accountKind === "user" ? person.id : null,
      label: identity.label,
      externalId: identity.externalId,
      scopeSets: sets,
      scopes,
      accessToken: exchanged.tokens.accessToken,
      refreshToken: exchanged.tokens.refreshToken,
      expiresAt: exchanged.tokens.expiresAt,
      now: new Date(now),
    },
    settings() as never,
  );
  logEvent("oauth.connected", {
    ...log,
    account: state.accountKind,
    scopeSets: sets,
    reconnected: existing !== null,
  });
  const member = await userSubject(person.id).catch(() => null);
  await emit(async () => ({
    organizationId: person.org.orgId,
    actor: await userActor(person.id),
    ...catalogue.providerConnected({
      provider: { id, name: capability.label, kind: "oauth" },
      account: {
        kind: state.accountKind,
        ...(state.accountKind === "user"
          ? {
              user: member
                ? { id: member.id, email: member.email, name: member.name }
                : { id: person.id },
            }
          : {}),
        label: identity.label,
      },
      scopeSets: sets,
      reconnected: existing !== null,
    }),
  }));
  return redirect(safeReturnTo(state.returnTo));
}

/**
 * Serve `/connect/<id>` and `/connect/<id>/callback`, or null for a path
 * that is neither (the control plane's). GET only.
 */
export async function serveConnectRoute(
  request: Request,
  deps: ConnectRouteDeps = {},
): Promise<Response | null> {
  const parsed = parseConnectPath(new URL(request.url).pathname);
  if (!parsed) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  try {
    return parsed.kind === "start"
      ? await serveStart(request, parsed.id, deps)
      : await serveCallback(request, parsed.id, deps);
  } catch (error) {
    logEvent(
      "oauth.connect_failed",
      {
        provider: parsed.id,
        kind: parsed.kind,
        error: error instanceof Error ? error.name : "unknown",
      },
      "error",
    );
    return errorPage(
      500,
      CANT_CONNECT,
      "Something went wrong on the Gateway. Try again.",
    );
  }
}
