/**
 * The `oauth_client` capability (docs/capabilities.md "OAuth clients"): the
 * operator holds a social network's OAuth client as gateway secrets, and the
 * gateway completes apps' calls to that network's token endpoints with it.
 * Nothing else on the network's hosts is proxied: the app builds the
 * authorize URL from the public client id, keeps the user tokens and calls
 * the network's API with them itself. The client secret never reaches an
 * app, and token responses pass through unlogged.
 *
 * A client with a `scopePolicy` (Google, Microsoft) is shared by apps with
 * different needs, so each app's manifest entry lists the scope sets it
 * uses and the gateway holds it to them at every mint and refresh: the
 * grant it asks for, the request's `scope`, and what the provider says it
 * granted. The token endpoint is the whole boundary until the gateway
 * holds tokens; API calls don't pass through it.
 *
 *   GET|POST /api/integrations/<id>/<token host><token path>   the provider's answer
 *   GET      /api/integrations/<id>                            { capability, requested, configured, ready, clientId?, origin?, scopeSets?, scopes?, userScopes? }
 */
import {
  CATALOG,
  OAUTH_TOKEN_BODY_LIMIT,
  allowedScopes,
  carriesToken,
  declaredScopeSets,
  describeTokenEndpoints,
  grantedScopes,
  injectClientCredentials,
  jsonObject,
  oauthClientCredentials,
  oauthClientOrigin,
  parseIntegrationProxyPath,
  requestedGrantType,
  requestedScopes,
  requestedTokenScopes,
  rewriteTokenRequestScope,
  scopeExcess,
  tokenGrantType,
  USER_BOUND_GRANT_TYPES,
  type CapabilityLookup,
  type CapabilitySettings,
  type OAuthClientCapability,
  type OAuthClientCredentials,
  type OAuthScopePolicy,
  type TokenRequest,
  capabilitySettings,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { CapabilityRequest } from "@every-app/perimeter/manifest";
import type { IntegrationCallAdmission } from "@/server/integration-proxy";
import { forwardableHeaders } from "./forward";
import { setupInfo, type SetupInfo } from "@/server/setup-info";
import { capabilityRefusal, notConfiguredRefusal } from "./refusal";

/** Whether the app may use the client: its manifest lists it for writing. */
function requested(entry: CapabilityRequest | undefined): boolean {
  return entry?.access === "write";
}

/** What a gateway without the client lacks: the client's settings (server/setup-info.ts). */
function clientSetup(
  capability: OAuthClientCapability,
  command: string | null,
): SetupInfo {
  return setupInfo({
    label: capability.label,
    settings: capabilitySettings(capability),
    command,
    ...(capability.flow
      ? {
          alternative:
            "an owner or admin adds a client under Manage workspace → Providers",
        }
      : {}),
  });
}

/**
 * `GET /api/integrations/<id>`: whether a token call would go through, and
 * the public client id for the authorize URL (with the origin of a provider
 * whose instance the operator chose). Only an app that lists the client
 * learns whether the gateway holds it, or its id. With a scope policy, the
 * sets the app declares and the exact provider scopes to ask for; a void
 * grant keeps the id back too, so the app says "not available" instead of
 * starting a flow the gateway would refuse to complete.
 */
export function oauthClientStatus({
  id,
  capability,
  entry,
  env,
  lookup = CATALOG,
  client: resolved,
  connection,
  setupCommand = null,
}: {
  id: string;
  /** The client `id` names in the gateway's registry. */
  capability: OAuthClientCapability;
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
  /** The registry the id came from: a registered row's client reads as unset while unbound. */
  lookup?: CapabilityLookup;
  /**
   * The client already resolved (the Worker env's, or the one sealed in
   * D1: server/oauth/client.ts), when the gateway resolves it; absent, the
   * env alone is read as before.
   */
  client?: OAuthClientCredentials | null;
  /**
   * For a provider with a Gateway-owned flow, the caller's connection as
   * the proxy found it (null: none), with whether it covers the sets the
   * entry declares; absent when the gateway didn't look.
   */
  connection?: HeldConnectionStatus | null;
  /** `pnpm everyapp configure <app>`, or null (server/setup-info.ts). */
  setupCommand?: string | null;
}): Response {
  const flow = capability.flow ? ("both" as const) : ("app" as const);
  // A Gateway-owned flow is used with any grant (held-token calls read);
  // the app-driven token endpoints still need the write grant.
  const isRequested = capability.flow ? Boolean(entry) : requested(entry);
  const bound = !lookup.bound || lookup.bound(id);
  const client = !isRequested
    ? null
    : resolved !== undefined
      ? resolved
      : bound
        ? oauthClientCredentials(capability, env)
        : null;
  const origin = client ? oauthClientOrigin(capability, env) : null;
  const policy = capability.scopePolicy;
  // A requested client the gateway doesn't hold: what to set. A missing
  // connection is the person's to make (`connectPath`), not a setting.
  const setup =
    isRequested && !client
      ? clientSetup(capability, setupCommand)
      : { settings: [], setup: null, command: null };
  const extra = capability.flow
    ? {
        ...setup,
        flow,
        connectPath: `/connect/${encodeURIComponent(id)}`,
        ...(connection !== undefined ? { connection } : {}),
      }
    : { ...setup, flow };
  const readiness = (sets: readonly string[] | null) => {
    if (!client) return false;
    if (!capability.flow || connection === undefined) return true;
    if (!connection || connection.reconnect) return false;
    return (
      sets === null || sets.every((name) => connection.scopeSets.includes(name))
    );
  };
  if (policy && isRequested) {
    const sets = declaredScopeSets(policy, { scopes: entry?.["scopes"] });
    if (!sets) {
      return Response.json({
        capability: id,
        requested: true,
        configured: Boolean(client),
        ready: false,
        scopeSets: [],
        ...extra,
      });
    }
    const { scopes, userScopes } = requestedScopes(policy, sets);
    return Response.json({
      capability: id,
      requested: true,
      configured: Boolean(client),
      ready: readiness(sets),
      ...(client ? { clientId: client.clientId } : {}),
      ...(origin ? { origin } : {}),
      scopeSets: sets,
      scopes,
      ...(userScopes.length > 0 ? { userScopes } : {}),
      ...extra,
    });
  }
  return Response.json({
    capability: id,
    requested: isRequested,
    configured: Boolean(client),
    ready: readiness(null),
    ...(client ? { clientId: client.clientId } : {}),
    ...(origin ? { origin } : {}),
    ...extra,
  });
}

/** A connection as the status reports it (the SDK's `connection` field). */
export interface HeldConnectionStatus {
  account: "user" | "organization";
  label: string | null;
  scopeSets: readonly string[];
  ready: boolean;
  reconnect?: boolean;
}

/**
 * An app's call to one of an OAuth client's token endpoints, checked in
 * this order, each a refusal with its code: the endpoint, the app's grant
 * (with a scope policy, its declared sets), whom the call is for (never an
 * agent), the gateway's client, the body (with a policy: the grant type and
 * the scopes it asks for), and with a policy the provider's answer (the
 * scopes it says it granted).
 */
export async function handleOAuthClientCall({
  request,
  id,
  capability,
  entry,
  env,
  lookup = CATALOG,
  admit,
  fetchUpstream,
  onCall,
  resolveClient,
  setupCommand,
}: {
  request: Request;
  id: string;
  /** The client `id` names in the gateway's registry. */
  capability: OAuthClientCapability;
  /** The calling app's manifest entry for `id`, if it lists one. */
  entry: CapabilityRequest | undefined;
  env: CapabilitySettings;
  /** Where ids are found, for the route parse: the registry the caller used. */
  lookup?: CapabilityLookup;
  admit: () => Promise<IntegrationCallAdmission>;
  fetchUpstream: (request: Request) => Promise<Response>;
  /** Told of each call the provider answered (integration-proxy.ts). */
  onCall?: (report: { capability: string; status: number }) => void;
  /**
   * Resolve the client beyond the Worker env (the one sealed in D1,
   * server/oauth/client.ts); absent, the env alone is read as before.
   */
  resolveClient?: (input: {
    id: string;
    capability: OAuthClientCapability;
    env: CapabilitySettings;
    lookup: CapabilityLookup;
  }) => Promise<OAuthClientCredentials | null>;
  /** `pnpm everyapp configure <app>`, or null (server/setup-info.ts). */
  setupCommand?: string | null;
}): Promise<Response> {
  const notConfigured = () =>
    notConfiguredRefusal(clientSetup(capability, setupCommand ?? null));
  // An instance setting that isn't an https origin: no call can go through.
  if (capability.hostSetting && !oauthClientOrigin(capability, env)) {
    return notConfigured();
  }

  // 1. Token endpoints only, each with its methods.
  const url = new URL(request.url);
  const route = parseIntegrationProxyPath(
    url.pathname,
    url.search,
    env,
    lookup,
  );
  const method = request.method.toUpperCase();
  if (
    route?.kind !== "oauth_client" ||
    !(route.endpoint.methods as readonly string[]).includes(method)
  ) {
    return capabilityRefusal(
      403,
      "integration_path_not_allowed",
      `Through the gateway, ${capability.label} answers its token endpoints only: ${describeTokenEndpoints(capability)}. Call its API with the user's token directly.`,
    );
  }

  // 2. The deployed manifest listing the client for writing is the grant.
  if (!requested(entry)) {
    return capabilityRefusal(
      403,
      "capability_not_requested",
      `This app doesn't list ${capability.label} in its capabilities. Add capabilities: { ${JSON.stringify(id)}: { access: "write" } } to everyapp.config.ts and deploy again.`,
    );
  }
  // 2b. With a scope policy, the sets the entry declares are the grant. A
  // void grant (no sets, or any name this gateway doesn't offer) is refused
  // whole rather than narrowed silently, before anyone is admitted and
  // before the provider hears of it.
  const policy = capability.scopePolicy;
  const sets = policy
    ? declaredScopeSets(policy, { scopes: entry?.["scopes"] })
    : null;
  if (policy && !sets) {
    return capabilityRefusal(
      403,
      "integration_scopes_undeclared",
      undeclaredScopesMessage(capability, policy, id, entry),
    );
  }

  // 3. Whom the tokens are for (throws the entrypoint's caller_* refusals).
  // Agents can't complete an OAuth flow, and must not mint tokens.
  const { caller, user } = await admit();
  if (user?.channel === "mcp") {
    return capabilityRefusal(
      403,
      "integration_agent_not_allowed",
      `An agent can't connect or refresh ${capability.label} accounts: the person does it in the app.`,
    );
  }

  // 4. The gateway's client: read only while a registered row still has
  // the endpoints, hosts and setting names it was set for
  // (`oauth.client-bound-to-endpoints`), as an API-key row's key is.
  const client = resolveClient
    ? await resolveClient({ id, capability, env, lookup })
    : lookup.bound && !lookup.bound(id)
      ? null
      : oauthClientCredentials(capability, env);
  if (!client) return notConfigured();

  // 5a. The body, under its cap.
  const body = method === "GET" ? null : await readCapped(request);
  if (body === undefined) {
    return capabilityRefusal(
      413,
      "integration_body_too_large",
      `A token request's body is at most ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB.`,
    );
  }
  // 5b. With a scope policy the body alone decides the grant and the
  // scopes: a query string naming them is refused outright, so no fallback
  // read of the query ever settles what the body left out. In the body,
  // `grant_type` once: the parsers read the first copy, and the provider
  // would see both.
  if (
    policy &&
    ["grant_type", "scope", "user_scope"].some((name) =>
      route.upstream.searchParams.has(name),
    )
  ) {
    return capabilityRefusal(
      400,
      "integration_body_invalid",
      "Put grant_type, scope and user_scope in the token request's body, not its query string; the gateway decides on the body.",
    );
  }
  if (
    policy &&
    body &&
    isFormBody(request.headers) &&
    new URLSearchParams(body).getAll("grant_type").length > 1
  ) {
    return capabilityRefusal(
      400,
      "integration_body_invalid",
      "grant_type appears more than once in the token request's body; name it once.",
    );
  }
  // 5c. A user's grants only, then the client put on the body. The
  // client-credentials grant, and anything else the network serves on the
  // same endpoint, would mint a token for the gateway's own application,
  // with its settings, its webhooks and every tenant's tokens behind it.
  const grant = requestedGrantType({
    url: route.upstream,
    headers: request.headers,
    body,
  });
  if (grant !== null && !USER_BOUND_GRANT_TYPES.has(grant)) {
    return capabilityRefusal(
      403,
      "integration_grant_not_allowed",
      `Through the gateway, ${capability.label} completes a user's grants only (authorization_code, refresh_token and the network's token exchanges); grant_type ${JSON.stringify(grant.slice(0, 64))} would mint a token for the gateway's own client.`,
    );
  }
  const injected = injectClientCredentials(
    {
      url: route.upstream,
      headers: forwardableHeaders(request.headers),
      body,
    },
    route.endpoint,
    client,
  );
  if (!injected.ok) {
    return capabilityRefusal(400, "integration_body_invalid", injected.problem);
  }

  // Never the body, the query string or the answer: they carry the client,
  // codes and tokens. Scope set names are the manifest's public vocabulary.
  const logged = {
    capability: id,
    ...caller,
    host: route.upstream.host,
    path: route.upstream.pathname,
    method,
    grantType: tokenGrantType(injected),
    attribution: user ? "user" : "app",
    ...(user ? { userId: user.id } : {}),
    ...(sets ? { scopeSets: sets } : {}),
  };
  const scopeRefused = (
    status: number,
    code: string,
    message: string,
    excess?: string[],
  ) => {
    // `reason`, as egress.denied names it: `code` is a never-log key.
    logEvent(
      "integration.proxy.scope_refused",
      { ...logged, reason: code, ...(excess ? { excess } : {}) },
      "warn",
    );
    return capabilityRefusal(status, code, message);
  };

  let prepared: TokenRequest = injected;
  if (policy && sets) {
    // 5d. The policy's grants only: the ones that end in a person's own
    // tokens on this provider. A token exchange, or a request naming no
    // grant, is app-level on Google and Microsoft.
    const policyGrant = requestedGrantType(injected);
    if (!policy.grantTypes.includes(policyGrant)) {
      return scopeRefused(
        403,
        "integration_grant_not_allowed",
        `Through the gateway, ${capability.label} completes ${describeGrantTypes(policy)} grants only; ${policyGrant === null ? "a request without grant_type" : JSON.stringify(policyGrant.slice(0, 64))} isn't one of them. An app never gets app-level tokens with the operator's client.`,
      );
    }
    // 5e. A `scope` on the request stays within the declared sets, so the
    // provider is never asked for more than the status hands out. The list
    // is the app's own, up to the body cap: the message and the log line
    // carry its head only.
    const allowed = allowedScopes(policy, sets);
    const asked = requestedTokenScopes(policy, injected);
    const askedExcess = asked ? scopeExcess(asked, allowed) : [];
    if (askedExcess.length > 0) {
      const { shown, more } = headOf(askedExcess);
      return scopeRefused(
        403,
        "integration_scope_not_allowed",
        `This app may ask ${capability.label} for ${sets.join(", ")} (${requestedScopes(policy, sets).scopes.join(", ")}); the request also asks ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Build the authorize URL and the token request from integrationStatus().scopes.`,
        shown,
      );
    }
    // 5f. The request's `scope` as the provider takes it: Microsoft's names
    // the resource and is set to the app's list, Google's is dropped.
    prepared = rewriteTokenRequestScope(policy, sets, injected);
  }
  const upstreamRequest = new Request(prepared.url, {
    method,
    headers: prepared.headers,
    body: prepared.body,
    signal: request.signal,
    // The client must never follow a redirect to another host.
    redirect: "manual",
  });

  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    // Its name only: a message may quote the URL, and the query rule puts
    // the client secret there.
    logEvent(
      "integration.proxy.upstream_failed",
      {
        ...logged,
        phase: "connect",
        error: error instanceof Error ? error.name : "unknown",
      },
      "error",
    );
    return capabilityRefusal(
      502,
      "integration_upstream_failed",
      `${capability.label} could not be reached.`,
    );
  }
  logEvent("integration.proxy.call", { ...logged, status: response.status });
  onCall?.({ capability: id, status: response.status });

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  if (!policy || !sets || !response.ok) {
    // A provider's own error streams through as it came, so the app can
    // tell it from a gateway refusal; it carries no token.
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // 7. What the provider says it granted. Google and Slack take no `scope`
  // on the token endpoint, and Microsoft may add what the person consented
  // to before, so the answer is the only place the gateway learns what a
  // token holds. A refused answer is dropped here: its tokens are never
  // forwarded, stored, logged or revoked, since nobody holds the string.
  let text: string | undefined;
  try {
    text = await readCapped(response);
  } catch (error) {
    // The answer broke off (the provider's stream failed, or the app hung
    // up) part way through: the entrypoint's 500 would log the message,
    // which may quote what was read so far. Its name only, as above.
    logEvent(
      "integration.proxy.upstream_failed",
      {
        ...logged,
        phase: "answer",
        error: error instanceof Error ? error.name : "unknown",
      },
      "error",
    );
    return capabilityRefusal(
      502,
      "integration_upstream_failed",
      `${capability.label}'s answer broke off before the gateway had read it; nothing was passed on.`,
    );
  }
  const answer = text === undefined ? null : jsonObject(text);
  if (!answer) {
    return scopeRefused(
      502,
      "integration_response_invalid",
      `${capability.label} answered with something that isn't a token response (over ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB or not a JSON object); nothing was passed on.`,
    );
  }
  // The body was decoded on read, so its length and encoding are no longer
  // the provider's.
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  const forward = () =>
    new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  // No token (Slack's `ok: false`): an error the app must see, not a grant.
  if (!carriesToken(answer)) return forward();
  const granted = grantedScopes(policy, answer);
  if (!granted) {
    return scopeRefused(
      502,
      "integration_scope_unverified",
      `${capability.label} issued a token without saying which scopes it carries, so the gateway can't hold it to this app's scope sets; nothing was passed on. Ask the person to connect again.`,
    );
  }
  const excess = scopeExcess(granted, allowedScopes(policy, sets));
  if (excess.length > 0) {
    return scopeRefused(
      403,
      "integration_scope_exceeded",
      `${capability.label} granted scopes this app doesn't declare: ${excess.join(", ")}. It declares ${sets.join(", ")} (${requestedScopes(policy, sets).scopes.join(", ")}). Nothing was passed on. ${RECOVERY[policy.dialect]}`,
      excess,
    );
  }
  return forward();
}

/**
 * How a person's wider grant is undone, per provider: Google issues a token
 * for exactly one authorization, so asking again narrowly is enough;
 * Microsoft and Slack accumulate consent per client or workspace, so the
 * consent itself has to go.
 */
const RECOVERY: Record<OAuthScopePolicy["dialect"], string> = {
  google:
    "Ask for only the scopes integrationStatus() returns, without include_granted_scopes, and connect again; if the app needs more, add the scope set to everyapp.config.ts and deploy.",
  microsoft:
    "On a shared Microsoft client a token carries everything the person consented to this client: have them remove this app's consent at https://myapplications.microsoft.com and connect again, or add the scope set to everyapp.config.ts and deploy.",
  slack:
    "Slack scopes add up per workspace installation: reinstall the app in the workspace with only the status's scopes, or add the scope set to everyapp.config.ts and deploy.",
  space:
    "Ask for only the scopes integrationStatus() returns and connect again, or add the scope set to everyapp.config.ts and deploy.",
  comma:
    "Ask for only the scopes integrationStatus() returns and connect again, or add the scope set to everyapp.config.ts and deploy.",
};

/** The policy's grants as a sentence lists them: "authorization_code and refresh_token". */
function describeGrantTypes(policy: OAuthScopePolicy): string {
  const names = policy.grantTypes.map((grant) =>
    grant === null ? "a code exchange without grant_type" : grant,
  );
  return names.length <= 1
    ? (names[0] ?? "no")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Why the entry's `scopes` grant nothing: the sets it names that this
 * gateway doesn't offer (a newer CLI's names, or a typo), or else no usable
 * list at all.
 */
function undeclaredScopesMessage(
  capability: OAuthClientCapability,
  policy: OAuthScopePolicy,
  id: string,
  entry: CapabilityRequest | undefined,
): string {
  const offered = Object.keys(policy.sets).join(", ");
  const declared: unknown = entry?.["scopes"];
  const unknown = Array.isArray(declared)
    ? [
        ...new Set(
          declared.filter(
            (name): name is string =>
              typeof name === "string" && !Object.hasOwn(policy.sets, name),
          ),
        ),
      ].map((name) => name.slice(0, 64))
    : [];
  if (unknown.length > 0) {
    return `This app's ${capability.label} entry names scope sets this gateway doesn't offer: ${unknown.join(", ")}. It offers: ${offered}. Fix everyapp.config.ts and deploy again, or update the gateway (everyapp update) if it is newer than this one.`;
  }
  return `This app lists ${capability.label} without the scope sets it uses. Add scopes: [...] (one or more of: ${offered}) to its ${JSON.stringify(id)} entry in everyapp.config.ts and deploy again.`;
}

/** Whether a body is form-encoded, read as the SDK's parsers read the type. */
function isFormBody(headers: Headers): boolean {
  const type = (headers.get("content-type") ?? "").split(";")[0]!;
  return type.trim().toLowerCase() === "application/x-www-form-urlencoded";
}

/** What a message or log line carries of a list the app controls: the first entries, each cut short. */
function headOf(list: readonly string[]): { shown: string[]; more: number } {
  const shown = list.slice(0, 10).map((entry) => entry.slice(0, 128));
  return { shown, more: list.length - shown.length };
}

/**
 * A request's or a provider answer's body as text, or undefined once it
 * passes the cap: counted as it streams, so a body that lies about (or
 * omits) its length still stops.
 */
async function readCapped(source: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<string | undefined> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > OAUTH_TOKEN_BODY_LIMIT) {
    return undefined;
  }
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OAUTH_TOKEN_BODY_LIMIT) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    // A failed read leaves the stream locked and its bytes held until it is
    // collected; cancelling an errored stream rejects with the same error.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
