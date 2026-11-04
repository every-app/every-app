/**
 * The Gateway-owned OAuth flow (docs/design/2026-11-oauth-simplify.md), on
 * the gateway host, for a signed-in member connecting inside an app:
 *
 *   GET /connect/<id>?app=<app id>&return=…
 *     → 302 to the provider's authorize URL, asking for exactly the scopes
 *       the app's everyapp.config.ts lists (plus the spec's identity
 *       scopes), PKCE S256 when the spec says, a one-use state
 *   GET /connect/<id>/callback?code&state      ← the redirect URI registered
 *     → the code exchanged, the mint check (a token carrying scopes beyond
 *       those asked is dropped), the connection stored sealed as this
 *       person's in this app, 302 to `return`
 *
 * A provider's `error`, a bad state or a refused token ends on a Gateway
 * page, never a redirect. Logs name the provider, the organization, the
 * person, the app and scope names; never a code, a token, the client, the
 * verifier or the state.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  OAUTH_TOKEN_BODY_LIMIT,
  grantedScopes,
  isRemoteMcpProviderIdOf,
  joinScopes,
  requestedScopes,
  scopeExcess,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { auth as betterAuth } from "@/auth";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import {
  resolveOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { gatewayProviders } from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OAuthStateRepository } from "@/server/repositories/OAuthStateRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { isUserBanned } from "@/server/user-ban";
import { appForMember } from "./appAccess";
import { resolveOAuthClient, type OAuthClientResolver } from "./client";
import { errorPage } from "./page";
import { redirectUriFor } from "./service";
import { tokenCall, type Fetch } from "./tokens";

const CONNECT_PREFIX = "/connect/";
/** Where the browser lands after a connect with no `return`. */
export const DEFAULT_RETURN = "/settings/accounts";
/** How long a state row lives. */
const STATE_TTL_MS = 10 * 60 * 1000;
const PROVIDER_ID = /^[a-z][a-z0-9-]{1,39}$/;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Authorize parameters the Gateway sets itself; a spec's `authorizeParams` never replaces them. */
const OWN_PARAMS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  // Google's incremental auth would hand back every scope the person ever
  // granted the client, in any app: never asked for.
  "include_granted_scopes",
]);

interface ConnectRouteDeps {
  fetchUpstream?: Fetch;
  resolveClient?: OAuthClientResolver;
  now?: () => number;
}

type ConnectEnv = typeof env & {
  GATEWAY_URL?: string;
  APP_BASE_DOMAIN?: string;
  THIRD_PARTY_DOMAIN?: string;
  GATEWAY_DEPLOYMENT_MODE?: string;
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
  return { id, kind: match[2] === "/callback" ? "callback" : "start" };
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
  const identity = capability.flow.identity;
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

/** The scope strings an app's entry for the provider lists, or null when it lists no entry. */
function declaredScopes(
  manifest: Record<string, unknown> | null,
  id: string,
): string[] | null {
  const capabilities = manifest?.["capabilities"];
  if (!capabilities || typeof capabilities !== "object") return null;
  const entry = (capabilities as Record<string, unknown>)[id];
  if (!entry || typeof entry !== "object") return null;
  const scopes = (entry as Record<string, unknown>)["scopes"];
  return Array.isArray(scopes)
    ? scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
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
  const slug = url.searchParams.get("app")?.trim() ?? "";
  if (!slug) {
    return errorPage(
      400,
      CANT_CONNECT,
      "Connect from inside the app that needs this account: a connection belongs to one app.",
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
  const app = APP_ID.test(slug)
    ? await appForMember({
        organizationId: person.org.orgId,
        userId: person.id,
        slug,
        sharedApps: platformPolicy(settings()).sharedApps,
      })
    : null;
  if (!app) {
    return errorPage(
      404,
      CANT_CONNECT,
      `No app ${slug} that you can open is on this Gateway.`,
    );
  }
  const declared = declaredScopes(app.manifest, id);
  if (declared === null) {
    return errorPage(
      400,
      CANT_CONNECT,
      `${app.name} doesn't list ${capability.label} in its everyapp.config.ts, so it can't connect an account there.`,
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
  const flow = capability.flow;
  const scopes = requestedScopes(flow, declared);
  const returnTo = safeReturnTo(url.searchParams.get("return"));
  const state = randomToken(32);
  const verifier = randomToken(48);
  const now = (deps.now ?? Date.now)();
  await OAuthStateRepository.put({
    state,
    providerId: id,
    organizationId: person.org.orgId,
    userId: person.id,
    appRowId: app.rowId,
    codeVerifier: verifier,
    scopes,
    returnTo,
    now: new Date(now),
    ttlMs: STATE_TTL_MS,
  });
  const authorize = new URL(flow.authorizeUrl);
  for (const [name, value] of Object.entries(flow.authorizeParams ?? {})) {
    if (!OWN_PARAMS.has(name)) authorize.searchParams.set(name, value);
  }
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", client.clientId);
  authorize.searchParams.set("redirect_uri", redirectUriFor(id, settings()));
  if (scopes.length > 0) {
    authorize.searchParams.set("scope", joinScopes(flow, scopes));
  }
  authorize.searchParams.set("state", state);
  if (flow.pkce) {
    authorize.searchParams.set("code_challenge", await s256(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
  }
  // The resource the tokens are for (RFC 8707): an MCP server's URL.
  if (flow.resource) authorize.searchParams.set("resource", flow.resource);
  logEvent("oauth.connect_started", {
    provider: id,
    org: person.org.orgId,
    user_id: person.id,
    app_row_id: app.rowId,
    scopes,
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
  if (!capability || capability.mode !== "oauth_client") {
    return errorPage(
      404,
      CANT_CONNECT,
      `No OAuth provider ${id} is on this Gateway.`,
    );
  }
  const app = await AppRepository.findCallableById(
    state.appRowId,
    person.org.orgId,
  );
  if (!app) {
    return errorPage(
      404,
      CANT_CONNECT,
      "The app this connect was for is gone. Nothing was connected.",
    );
  }
  const flow = capability.flow;
  // The mix-up defense (RFC 9207): an authorization server that says who
  // it is must be the one the flow is for.
  const iss = url.searchParams.get("iss");
  if (iss !== null && flow.issuer && iss !== flow.issuer) {
    logEvent("oauth.callback_refused", { ...log, reason: "issuer" }, "warn");
    return errorPage(
      400,
      CANT_CONNECT,
      "The answer came from another authorization server than the one this connect started with. Nothing was connected. Start again.",
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
  // The mint check: the token may hold what was asked (the app's scopes
  // and the spec's identity ones) and nothing more. Otherwise the tokens
  // are dropped here: never stored, forwarded or logged.
  // One carve-out: the calling app's own remote MCP row (`<app>-mcp`) keeps
  // what its server grants, never refused. The token reaches that server
  // alone, and the ToolBus's per-tool risk guards what it does. Any other
  // row, even one whose spec sets a `resource`, gets the check.
  const mcpServer =
    flow.resource !== undefined && isRemoteMcpProviderIdOf(id, app.appSlug);
  const granted =
    grantedScopes(flow, exchanged.tokens.body, state.scopes) ??
    (mcpServer ? [...state.scopes] : null);
  if (!granted) {
    logEvent(
      "oauth.callback_refused",
      { ...log, app_row_id: state.appRowId, reason: "scope_unreadable" },
      "warn",
    );
    return errorPage(
      400,
      CANT_CONNECT,
      `${capability.label} didn't say which scopes it granted in a form the Gateway reads; nothing was kept.`,
    );
  }
  const excess = mcpServer ? [] : scopeExcess(flow, granted, state.scopes);
  if (excess.length > 0) {
    logEvent(
      "oauth.callback_refused",
      {
        ...log,
        app_row_id: state.appRowId,
        reason: "scope_excess",
        excess: excess.slice(0, 20),
      },
      "warn",
    );
    return errorPage(
      400,
      CANT_CONNECT,
      `${capability.label} granted more than ${app.name} asked for (${excess.join(", ")}), so nothing was kept. This happens when the client remembers scopes approved for another app. Limit the client's scopes at the provider's console, or give ${app.name} a client of its own.`,
    );
  }
  const identity = await readIdentity(
    capability,
    exchanged.tokens.accessToken,
    fetchUpstream,
    log,
  );
  const key = {
    organizationId: person.org.orgId,
    providerId: id,
    userId: person.id,
    appRowId: state.appRowId,
  };
  const existing = await ProviderConnectionRepository.find(key);
  await ProviderConnectionRepository.upsert(
    {
      ...key,
      label: identity.label,
      externalId: identity.externalId,
      scopes: granted,
      accessToken: exchanged.tokens.accessToken,
      refreshToken: exchanged.tokens.refreshToken,
      expiresAt: exchanged.tokens.expiresAt,
      now: new Date(now),
    },
    settings() as never,
  );
  logEvent("oauth.connected", {
    ...log,
    app_row_id: state.appRowId,
    scopes: granted,
    reconnected: existing !== null,
  });
  const member = await userSubject(person.id).catch(() => null);
  await emit(async () => ({
    organizationId: person.org.orgId,
    actor: await userActor(person.id),
    ...catalogue.providerConnected({
      provider: { id, name: capability.label, kind: "oauth" },
      account: {
        user: member
          ? { id: member.id, email: member.email, name: member.name }
          : { id: person.id },
        label: identity.label,
      },
      app: { id: app.appSlug, rowId: app.id, name: app.name },
      scopes: granted,
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
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
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
