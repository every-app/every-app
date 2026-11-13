/**
 * The Gateway-owned OAuth flow
 * (docs/design/2026-11-oauth-one-connection.md), on the gateway host, for
 * a signed-in member connecting inside an app. A person has one connection
 * to a provider, and each app they allow uses it:
 *
 *   GET /connect/<id>?app=<app id>&return=…
 *     → the person's connection already holds what the app lists, and they
 *       allowed the app: 302 to `return`
 *     → it holds what the app lists, and they haven't allowed the app yet:
 *       302 to the Gateway's own Allow page (/oauth/app-access), with a
 *       one-use state; no provider is asked
 *     → otherwise 302 to the provider's authorize URL, asking for every
 *       scope the organization's apps list for it (plus the spec's
 *       identity scopes), PKCE S256 when the spec says, a one-use state
 *   GET /connect/<id>/callback?code&state      ← the redirect URI registered
 *     → the code exchanged, the mint check (a token carrying scopes beyond
 *       those asked is dropped), the connection stored sealed as this
 *       person's, the app the connect started in allowed, 302 to `return`
 *   POST /connect/<id>/allow  state, decision  ← the Allow page's form
 *     → on "approve" the app allowed; either way 303 to `return`
 *
 * Reconnect on Your connections → Accounts (`startReconnect`, a server
 * function) starts the same authorize step for the person's own
 * connection, in the name of an app they allowed that needs it; its
 * callback also allows every app they had allowed, for what each lists
 * now. When the connection already holds all of that, no provider is
 * asked and those apps are allowed there and then.
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
  canonicalScopes,
  grantedScopes,
  isRemoteMcpProviderIdOf,
  joinScopes,
  missingScopes,
  requestedScopes,
  scopeExcess,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { auth as betterAuth } from "@/auth";
import {
  ALLOW_APPROVE,
  ALLOW_FIELDS,
  ALLOW_PAGE,
  ConnectionAction,
  ReconnectOutcome,
} from "@/schemas/app-access";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor, userSubject } from "@/server/events/subjects";
import {
  resolveOrgContext,
  type OrgContext,
} from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import {
  OAuthStatePurpose,
  OAuthStateRepository,
} from "@/server/repositories/OAuthStateRepository";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import {
  ProviderConnectionRepository,
  type ConnectionKey,
} from "@/server/repositories/ProviderConnectionRepository";
import { isUserBanned } from "@/server/user-ban";
import {
  appForMember,
  connectionAction,
  declaredScopes,
  memberAppByRow,
  scopesListedFor,
  unaskedScopes,
  type ConnectApp,
  type ScopedConnection,
} from "./appAccess";
import { AllowRefusal, allowCheck } from "./appAccessConsent";
import { resolveOAuthClient, type ResolvedOAuthClient } from "./client";
import { errorPage } from "./page";
import { redirectUriFor } from "./service";
import { OAUTH_USER_AGENT, tokenCall, type Fetch } from "./tokens";

const CONNECT_PREFIX = "/connect/";
/** Where the browser lands after a connect with no `return`. */
export const DEFAULT_RETURN = "/connections/accounts";
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

type ConnectRouteKind = "start" | "callback" | "allow";

/** Which route a path is: the start, the callback, the Allow page's form, or none. */
function parseConnectPath(
  pathname: string,
): { id: string; kind: ConnectRouteKind } | null {
  if (!pathname.startsWith(CONNECT_PREFIX)) return null;
  const rest = pathname.slice(CONNECT_PREFIX.length);
  const match = /^([^/]+)(\/callback|\/allow)?\/?$/.exec(rest);
  if (!match) return null;
  let id: string;
  try {
    id = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!PROVIDER_ID.test(id)) return null;
  return {
    id,
    kind:
      match[2] === "/callback"
        ? "callback"
        : match[2] === "/allow"
          ? "allow"
          : "start",
  };
}

/** A redirect: 302 after a GET, 303 after the Allow page's POST. */
function redirect(location: string, status: 302 | 303 = 302): Response {
  return new Response(null, {
    status,
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

/** The signed-in member behind a request with their organization, or null. */
export async function signedIn(
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
          "user-agent": OAUTH_USER_AGENT,
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

/**
 * How the provider names an account, for telling one from another: its
 * id there, else its label. Null when the provider says neither.
 */
function accountKey(account: {
  externalId: string | null;
  label: string | null;
}): string | null {
  return account.externalId ?? account.label;
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
      "Connect from inside the app that needs this account.",
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
  const client = await resolveOAuthClient({
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
  const returnTo = safeReturnTo(url.searchParams.get("return"));
  const now = (deps.now ?? Date.now)();
  const key = {
    organizationId: person.org.orgId,
    providerId: id,
    userId: person.id,
  };
  const connection = await ProviderConnectionRepository.find(key);
  const access = connection
    ? await ProviderAppAccessRepository.find({ ...key, appRowId: app.rowId })
    : null;
  const action = connectionAction(flow, connection, access, declared);
  if (action === null) return redirect(returnTo);
  if (action === ConnectionAction.Allow) {
    // The connection holds what the app lists: no provider is asked. The
    // person allows the app on the Gateway's own page, once.
    const state = randomToken(32);
    await OAuthStateRepository.put({
      state,
      ...key,
      appRowId: app.rowId,
      purpose: OAuthStatePurpose.Allow,
      codeVerifier: "",
      scopes: canonicalScopes(flow, declared),
      returnTo,
      now: new Date(now),
    });
    logEvent("oauth.allow_started", {
      provider: id,
      org: person.org.orgId,
      user_id: person.id,
      app_row_id: app.rowId,
    });
    return redirect(`${ALLOW_PAGE}?state=${encodeURIComponent(state)}`);
  }
  return redirect(
    await authorizeUrl({
      person: key,
      id,
      capability,
      client,
      app,
      declared,
      purpose: OAuthStatePurpose.Authorize,
      returnTo,
      now,
    }),
  );
}

/**
 * Put a one-use state for the provider's callback and return the
 * provider's authorize URL. The provider is asked once for what every app
 * of the organization lists, so a later app needs the person's Allow and
 * not another consent.
 */
async function authorizeUrl(input: {
  person: { organizationId: string; userId: string };
  id: string;
  capability: OAuthClientCapability;
  client: ResolvedOAuthClient;
  /** The app the connect is in the name of: the callback allows it. */
  app: ConnectApp;
  /** What that app lists for the provider. */
  declared: readonly string[];
  purpose: OAuthStatePurpose.Authorize | OAuthStatePurpose.Reconnect;
  returnTo: string;
  now: number;
}): Promise<string> {
  const { person, id, capability, client, app } = input;
  const flow = capability.flow;
  const scopes = requestedScopes(flow, [
    ...input.declared,
    ...(await scopesListedFor({
      organizationId: person.organizationId,
      providerId: id,
    })),
  ]);
  const state = randomToken(32);
  const verifier = randomToken(48);
  await OAuthStateRepository.put({
    state,
    organizationId: person.organizationId,
    providerId: id,
    userId: person.userId,
    appRowId: app.rowId,
    purpose: input.purpose,
    codeVerifier: verifier,
    scopes,
    returnTo: input.returnTo,
    now: new Date(input.now),
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
    org: person.organizationId,
    user_id: person.userId,
    app_row_id: app.rowId,
    purpose: input.purpose,
    scopes,
  });
  return authorize.toString();
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
  // An Allow page's state asked no provider anything: it is not this
  // route's to spend, and is spent all the same.
  if (
    !state ||
    state.providerId !== id ||
    state.purpose === OAuthStatePurpose.Allow
  ) {
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
  const client = await resolveOAuthClient({
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
  // The mint check: the token may hold what was asked (the scopes the
  // organization's apps list and the spec's identity ones) and nothing
  // more. Otherwise the tokens are dropped here: never stored, forwarded
  // or logged.
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
      `${capability.label} granted more than the apps here list (${excess.join(", ")}), so nothing was kept. This happens when the client remembers scopes approved somewhere else. Limit the client's scopes at the provider's console.`,
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
  };
  const existing = await ProviderConnectionRepository.find(key);
  // The apps a person allowed were allowed the account they had connected.
  // A first connection, another account, or one a provider that names
  // accounts wouldn't name this time is not that account for certain, so
  // each app asks again. A provider that names no account can't show a
  // change, and its apps stay allowed across a reconnect. A connection
  // that was never named (its account lookup failed, as GitHub's did
  // before the Gateway sent a User-Agent) takes the name read now: the
  // same person at the same provider, with nothing to tell the accounts
  // apart.
  const named = accountKey(identity);
  const existingKey = existing ? accountKey(existing) : null;
  const sameAccount =
    existing !== null &&
    (flow.identity
      ? named !== null && (existingKey === null || existingKey === named)
      : true);
  if (!sameAccount) {
    await ProviderAppAccessRepository.removeForConnection(key);
  }
  // An Allow page still open in another tab showed the account as it was:
  // its form is spent here, so it can't allow an app the account that
  // replaced it.
  await OAuthStateRepository.removeAllow(key);
  await ProviderConnectionRepository.upsert(
    {
      ...key,
      appRowId: state.appRowId,
      label: identity.label,
      externalId: identity.externalId,
      scopes: granted,
      askedScopes: canonicalScopes(flow, state.scopes),
      accessToken: exchanged.tokens.accessToken,
      refreshToken: exchanged.tokens.refreshToken,
      expiresAt: exchanged.tokens.expiresAt,
      now: new Date(now),
    },
    settings() as never,
  );
  // Connecting from inside an app allows that app in the same step, if
  // the person still opens it and it still lists the provider: the
  // minutes at the provider may have changed either.
  const opened = await appForMember({
    organizationId: person.org.orgId,
    userId: person.id,
    slug: app.appSlug,
  });
  const declared =
    opened?.rowId === state.appRowId
      ? declaredScopes(opened.manifest, id)
      : null;
  if (declared !== null) {
    await ProviderAppAccessRepository.allow({
      ...key,
      appRowId: state.appRowId,
      scopes: canonicalScopes(flow, declared),
      now: new Date(now),
    });
  }
  // Reconnect from Your connections → Accounts: the person's apps were
  // allowed this same account, so each is allowed for what it lists now,
  // where the new token holds it.
  const reallowed =
    state.purpose === OAuthStatePurpose.Reconnect && sameAccount
      ? await reallowApps({
          key,
          flow,
          connection: {
            scopes: granted,
            askedScopes: canonicalScopes(flow, state.scopes),
          },
          now,
        })
      : [];
  logEvent("oauth.connected", {
    ...log,
    app_row_id: state.appRowId,
    scopes: granted,
    reconnected: existing !== null,
    purpose: state.purpose,
    reallowed: reallowed.map((app) => app.rowId),
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

/** An app the person allowed to use their connection, as it is now. */
interface AllowedApp {
  app: ConnectApp;
  /** What the app lists for the provider now. */
  declared: string[];
  /** What the person allowed it, canonical. */
  allowed: string[];
}

/**
 * The apps the person allowed to use their connection that they still
 * open and that still list the provider. Any other access row is left as
 * it is: the app can't use the connection either way.
 */
async function allowedApps(key: ConnectionKey): Promise<AllowedApp[]> {
  const out: AllowedApp[] = [];
  for (const row of await ProviderAppAccessRepository.listForConnection(key)) {
    const app = await memberAppByRow({ ...key, appRowId: row.appRowId });
    if (!app) continue;
    const declared = declaredScopes(app.manifest, key.providerId);
    if (declared === null) continue;
    out.push({ app, declared, allowed: row.scopes });
  }
  return out;
}

/**
 * Allow each app the person allowed for what it lists now, where it lists
 * more than they allowed it and the provider has been asked for all of it
 * on the connection (a scope the person declined there doesn't hold an
 * app back). The apps allowed.
 */
async function reallowApps(input: {
  key: ConnectionKey;
  flow: OAuthClientCapability["flow"];
  connection: ScopedConnection;
  now: number;
}): Promise<ConnectApp[]> {
  const { key, flow } = input;
  const out: ConnectApp[] = [];
  for (const each of await allowedApps(key)) {
    if (unaskedScopes(flow, input.connection, each.declared).length > 0) {
      continue;
    }
    if (missingScopes(flow, each.allowed, each.declared).length === 0) continue;
    await ProviderAppAccessRepository.allow({
      ...key,
      appRowId: each.app.rowId,
      scopes: canonicalScopes(flow, each.declared),
      now: new Date(input.now),
    });
    out.push(each.app);
  }
  return out;
}

type ReconnectResult =
  | { outcome: ReconnectOutcome.Provider; url: string }
  | {
      outcome: ReconnectOutcome.Allowed;
      /** The provider, by its label. */
      provider: string;
    };

/**
 * Reconnect on Your connections → Accounts, for the person's own
 * connection to `providerId` and every app they allowed to use it. When
 * the connection expired, or the provider was never asked for a scope one
 * of those apps lists, the provider is asked again, in the name of the
 * app that needs it, for every scope the organization's apps list: the
 * URL to send the browser to, whose callback allows each of those apps
 * for what it lists now.
 * Otherwise no provider is asked, and each app that lists more than the
 * person allowed it is allowed for what it lists now: selecting
 * Reconnect is the person's OK. With `fresh` (Reconnect from the row's
 * menu, on a connection that may be healthy) the provider is asked
 * either way; the callback replaces the person's one connection to it.
 */
export async function startReconnect(
  input: ConnectionKey,
  options: { fresh?: boolean } = {},
): Promise<ReconnectResult> {
  const registry = await gatewayProviders();
  const capability = registry.get(input.providerId);
  if (!capability || capability.mode !== "oauth_client") {
    throw new PublicError(
      "PROVIDER_NOT_FOUND",
      `No OAuth provider ${input.providerId} is on this Gateway.`,
    );
  }
  const connection = await ProviderConnectionRepository.find(input);
  if (!connection) {
    throw new PublicError("CONNECTION_NOT_FOUND", "No such connection");
  }
  const flow = capability.flow;
  const now = Date.now();
  const apps = await allowedApps(input);
  const short = apps.filter(
    (each) => unaskedScopes(flow, connection, each.declared).length > 0,
  );
  if (options.fresh || connection.status === "expired" || short.length > 0) {
    const first = short[0] ?? apps[0];
    if (!first) {
      throw new PublicError(
        "CONNECTION_UNUSED",
        `No app you allowed uses this ${capability.label} connection. Connect it from inside the app that needs it.`,
      );
    }
    const client = await resolveOAuthClient({
      id: input.providerId,
      capability,
      env: settings() as never,
      lookup: registry,
    });
    if (!client) {
      throw new PublicError(
        "OAUTH_CLIENT_REQUIRED",
        `${capability.label} has no client on this Gateway yet. An owner or admin adds one under Manage workspace → Providers.`,
      );
    }
    return {
      outcome: ReconnectOutcome.Provider,
      url: await authorizeUrl({
        person: input,
        id: input.providerId,
        capability,
        client,
        app: first.app,
        declared: first.declared,
        purpose: OAuthStatePurpose.Reconnect,
        returnTo: DEFAULT_RETURN,
        now,
      }),
    };
  }
  const allowed = await reallowApps({
    key: input,
    flow,
    connection,
    now,
  });
  logEvent("oauth.apps_reallowed", {
    provider: input.providerId,
    org: input.organizationId,
    user_id: input.userId,
    app_row_ids: allowed.map((app) => app.rowId),
  });
  return {
    outcome: ReconnectOutcome.Allowed,
    provider: capability.label,
  };
}

const CANT_ALLOW = "Can't allow this app";

/**
 * The Allow page's form: the person allows the app the state names to use
 * their connection, or leaves it as it was. The state is spent either
 * way. What the page showed is checked again: the app still lists the
 * provider and the person still opens it, and their connection still
 * holds what the app lists.
 */
async function serveAllow(
  request: Request,
  id: string,
  deps: ConnectRouteDeps,
): Promise<Response> {
  const person = await signedIn(request);
  if (!person) {
    return errorPage(
      401,
      CANT_ALLOW,
      "Sign in to the Gateway in this browser, then open the app again.",
    );
  }
  const now = (deps.now ?? Date.now)();
  const log = { provider: id, org: person.org.orgId, user_id: person.id };
  const form = await request.formData().catch(() => null);
  const stateParam = form?.get(ALLOW_FIELDS.state);
  const state =
    typeof stateParam === "string" && stateParam
      ? await OAuthStateRepository.take(stateParam, new Date(now))
      : null;
  if (
    !state ||
    state.providerId !== id ||
    state.purpose !== OAuthStatePurpose.Allow
  ) {
    logEvent("oauth.allow_refused", { ...log, reason: "state" }, "warn");
    return errorPage(
      400,
      CANT_ALLOW,
      "This page was used already or expired. Open the app again.",
    );
  }
  if (state.userId !== person.id || state.organizationId !== person.org.orgId) {
    logEvent(
      "oauth.allow_refused",
      { ...log, reason: "foreign_state" },
      "warn",
    );
    return errorPage(
      400,
      CANT_ALLOW,
      "This was started by someone else, or in another organization. Open the app again.",
    );
  }
  const returnTo = safeReturnTo(state.returnTo);
  if (form?.get(ALLOW_FIELDS.decision) !== ALLOW_APPROVE) {
    return redirect(returnTo, 303);
  }
  const check = await allowCheck(person, state);
  if (check.refused !== null) {
    logEvent(
      "oauth.allow_refused",
      { ...log, app_row_id: state.appRowId, reason: check.refused },
      "warn",
    );
    if (check.refused === AllowRefusal.App) {
      return errorPage(
        404,
        CANT_ALLOW,
        "The app or the provider changed since this page opened. Open the app again.",
      );
    }
    const { capability, app } = check;
    // The person said yes to the scopes the page showed: an app that lists
    // more by now asks again, with a page that shows them.
    return errorPage(
      409,
      CANT_ALLOW,
      check.refused === AllowRefusal.Connection
        ? `Your ${capability.label} connection changed since this page opened. Open ${app.name} and connect again.`
        : `${app.name} asks for more than this page showed. Open ${app.name} again.`,
    );
  }
  const scopes = canonicalScopes(check.capability.flow, check.declared);
  await ProviderAppAccessRepository.allow({
    organizationId: person.org.orgId,
    providerId: id,
    userId: person.id,
    appRowId: state.appRowId,
    scopes,
    now: new Date(now),
  });
  logEvent("oauth.app_allowed", {
    ...log,
    app_row_id: state.appRowId,
    scopes,
  });
  return redirect(returnTo, 303);
}

/**
 * Serve `/connect/<id>`, `/connect/<id>/callback` (GET) and
 * `/connect/<id>/allow` (POST), or null for a path that is none of them
 * (the control plane's).
 */
export async function serveConnectRoute(
  request: Request,
  deps: ConnectRouteDeps = {},
): Promise<Response | null> {
  const parsed = parseConnectPath(new URL(request.url).pathname);
  if (!parsed) return null;
  const method = request.method.toUpperCase();
  if (parsed.kind === "allow") {
    if (method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
  } else if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  try {
    return parsed.kind === "start"
      ? await serveStart(request, parsed.id, deps)
      : parsed.kind === "callback"
        ? await serveCallback(request, parsed.id, deps)
        : await serveAllow(request, parsed.id, deps);
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
