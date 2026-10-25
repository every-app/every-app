import {
  CATALOG,
  ConfigurationError,
  GATEWAY_ERROR_HEADER,
  INTEGRATION_PROXY_PREFIX,
  OAUTH_TOKEN_BODY_LIMIT,
  allowedScopes,
  authorizationFor,
  capabilitySettings,
  carriesToken,
  declaredScopeSets,
  describeTokenEndpoints,
  grantedScopes,
  injectClientCredentials,
  integrationProxyPath,
  oauthClientCredentials,
  oauthClientOrigin,
  requestedScopes,
  requestedTokenScopes,
  rewriteTokenRequestScope,
  scopeExcess,
  tokenEndpointFor,
  tokenGrantType,
  type ApiKeyCapability,
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilityId,
  type EmailCapabilityStatus,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
  type OAuthClientCredentials,
  type OAuthScopePolicy,
  EMAIL_SENDERS_ENV,
  chooseEmailProvider,
  parseEmailList,
  parseEmailSender,
} from "../internal/index.js";
import {
  applyAttribution,
  checkAttribution,
  type GatewayCallFor,
} from "./attribution.js";
import {
  BINDING_ORIGIN,
  streamingRequest,
  type GatewayServiceBinding,
} from "./gatewayFetch.js";

export interface IntegrationFetchOptions {
  /**
   * The Worker env: the EVERY_APP_GATEWAY binding when deployed, or in local
   * dev EVERYAPP_DEV and the provider's key (e.g. DATAFORSEO_API_KEY in
   * `.dev.vars`).
   */
  env: object;
  /**
   * A provider the app lists in its manifest's `capabilities`: one whose
   * key the gateway holds, or one whose OAuth client it holds (its token
   * endpoints only). The built-in catalog's ids complete; a provider
   * registered on the gateway (`everyapp provider add`) is any other id,
   * reached through the binding, which checks it. The `email` capability
   * is sent with `sendEmail()` instead.
   */
  provider: ApiKeyCapabilityId | OAuthClientCapabilityId | (string & {});
  /**
   * Whom the call is for: the inbound request (its user), or
   * `{ background: true, organizationId }` for work no person started
   * (crons, Workflows, queues). An organization's own app may omit it for
   * background work, which is then the app's; a shared app's Worker must
   * pass one or the other ({@link AttributionError}).
   */
  for?: GatewayCallFor;
}

/**
 * A `fetch` for one of the gateway's capabilities. Call the provider's real
 * URLs (`https://api.dataforseo.com/v3/…`); this sends them over the
 * AppGateway binding, which checks the app's manifest lists the capability,
 * injects the key the gateway holds and forwards the call. The app never
 * sees the key. A refusal the gateway makes itself comes back as a response
 * {@link gatewayRefusal} recognizes; anything else is the provider's answer.
 *
 * For an OAuth client (`linkedin`, `mastodon`, ...) it reaches the
 * provider's token endpoints only, and the gateway puts its client on the
 * request: send the code (or refresh token) without `client_id` or
 * `client_secret`. Build the authorize URL with {@link authorizeUrl} from
 * {@link integrationStatus}, and call the provider's API with the user's
 * token directly.
 *
 * In local dev only, with no binding, the developer's own key or client
 * from `.dev.vars` reaches the provider directly, under the gateway's names;
 * that fallback knows the built-in catalog, not a gateway's registered rows.
 */
export function integrationFetch({
  env,
  provider,
  for: target,
}: IntegrationFetchOptions): typeof fetch {
  const integration = fetchableCapability(provider);
  checkAttribution(env, target, `integrationFetch("${provider}")`);
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!integration && !binding) {
    throw new ConfigurationError(
      `"${provider}" isn't in the built-in provider catalog. A provider registered on the gateway (everyapp provider add) is reached through the EVERY_APP_GATEWAY binding and has no local-development fallback yet.`,
    );
  }
  const local =
    binding || !integration ? null : localCredentials(integration, values);
  if (!binding && !local && integration) {
    throw new ConfigurationError(
      `${integration.label} is unavailable: deploy with the EVERY_APP_GATEWAY binding, or set ${capabilitySettings(integration).join(", ")} in .dev.vars for local development.`,
    );
  }

  return async (input, init) => {
    const outbound = new Request(input, init);
    const upstream = new URL(outbound.url);
    const headers = new Headers(outbound.headers);
    headers.delete("authorization");
    headers.delete("cookie");

    if (!integration) {
      // A gateway-registered provider: the gateway holds its spec, so the
      // gateway checks the host; here only that it is https at all.
      if (upstream.protocol !== "https:") {
        throw new TypeError(
          `integrationFetch("${provider}") reaches https URLs only, not ${upstream.protocol}//${upstream.host}.`,
        );
      }
      applyAttribution(headers, target);
      return binding!.fetch(
        streamingRequest(
          `${BINDING_ORIGIN}${integrationProxyPath(provider, upstream)}`,
          outbound,
          headers,
        ),
      );
    }

    if (integration.mode === "oauth_client") {
      return oauthClientCall({
        provider: provider as OAuthClientCapabilityId,
        capability: integration,
        outbound,
        upstream,
        headers,
        values,
        ...(binding
          ? { binding, target }
          : { client: local as OAuthClientCredentials }),
      });
    }

    if (
      upstream.protocol !== "https:" ||
      !(integration.hosts as readonly string[]).includes(upstream.host)
    ) {
      throw new TypeError(
        `integrationFetch("${provider}") only reaches ${integration.hosts.join(", ")}, not ${upstream.host}.`,
      );
    }
    if (binding) {
      applyAttribution(headers, target);
      return binding.fetch(
        streamingRequest(
          `${BINDING_ORIGIN}${integrationProxyPath(provider, upstream)}`,
          outbound,
          headers,
        ),
      );
    }

    applyAttribution(headers, undefined);
    // The developer's own key, put where the provider's entry says, as the
    // gateway would put its own.
    const auth = local as DevAuthorization;
    for (const [name, value] of Object.entries(auth.headers)) {
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(auth.query)) {
      upstream.searchParams.set(name, value);
    }
    return fetch(streamingRequest(upstream.toString(), outbound, headers));
  };
}

type DevAuthorization = NonNullable<ReturnType<typeof authorizationFor>>;

/**
 * The developer's own key or client from `.dev.vars` (with EVERYAPP_DEV
 * set), under the gateway's names; null until every setting it needs is.
 */
function localCredentials(
  integration: ApiKeyCapability | OAuthClientCapability,
  values: Record<string, unknown>,
): DevAuthorization | OAuthClientCredentials | null {
  if (!values["EVERYAPP_DEV"]) return null;
  if (integration.mode === "oauth_client") {
    return oauthClientCredentials(integration, values);
  }
  return authorizationFor(integration, values);
}

/**
 * A call to an OAuth client's token endpoint: over the binding, where the
 * gateway puts its client on it, or in local dev straight to the provider
 * with the developer's client put on it by the gateway's own rule.
 */
async function oauthClientCall({
  provider,
  capability,
  outbound,
  upstream,
  headers,
  values,
  binding,
  target,
  client,
}: {
  provider: OAuthClientCapabilityId;
  capability: OAuthClientCapability;
  outbound: Request;
  upstream: URL;
  headers: Headers;
  values: Record<string, unknown>;
  binding?: GatewayServiceBinding;
  target?: GatewayCallFor;
  client?: OAuthClientCredentials;
}): Promise<Response> {
  // With the binding the gateway resolves the provider's origin (Mastodon's
  // instance) and refuses any other, so any origin stands in for it here.
  const settings =
    binding && capability.hostSetting
      ? { [capability.hostSetting]: upstream.origin }
      : values;
  const endpoint = tokenEndpointFor(capability, upstream, settings);
  const method = outbound.method.toUpperCase();
  if (!endpoint || !(endpoint.methods as readonly string[]).includes(method)) {
    throw new TypeError(
      `integrationFetch("${provider}") only reaches ${capability.label}'s token endpoints (${describeTokenEndpoints(capability)}), not ${method} ${upstream.origin}${upstream.pathname}. Call its API with the user's token directly.`,
    );
  }

  if (binding) {
    applyAttribution(headers, target);
    return binding.fetch(
      streamingRequest(
        `${BINDING_ORIGIN}${integrationProxyPath(provider, upstream)}`,
        outbound,
        headers,
      ),
    );
  }

  applyAttribution(headers, undefined);
  // The gateway's scope checks, in its order, answering its refusals: an
  // app sees in `everyapp dev` what the gateway will say.
  const policy = capability.scopePolicy;
  const grant = policy
    ? devScopeSets(policy, provider, capability.label, values)
    : null;
  if (grant && "problem" in grant) {
    return devRefusal(403, grant.code, grant.problem);
  }
  const sets = grant?.sets;
  const body = method === "GET" ? null : await outbound.text();
  if (
    body !== null &&
    new TextEncoder().encode(body).byteLength > OAUTH_TOKEN_BODY_LIMIT
  ) {
    throw new TypeError(
      `A token request's body is at most ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB.`,
    );
  }
  if (
    policy &&
    ["grant_type", "scope", "user_scope"].some((name) =>
      upstream.searchParams.has(name),
    )
  ) {
    return devRefusal(
      400,
      "integration_body_invalid",
      "Put grant_type, scope and user_scope in the token request's body, not its query string; the gateway decides on the body.",
    );
  }
  let injected = injectClientCredentials(
    { url: upstream, headers, body },
    endpoint,
    client as OAuthClientCredentials,
  );
  if (!injected.ok) throw new TypeError(injected.problem);
  if (policy && sets) {
    const refused = refuseTokenRequest(policy, capability, sets, injected);
    if (refused) return refused;
    injected = {
      ok: true,
      ...rewriteTokenRequestScope(policy, sets, injected),
    };
  }
  const response = await fetch(
    new Request(injected.url, {
      method,
      headers: injected.headers,
      body: injected.body,
      signal: outbound.signal,
      // As the gateway: the client never follows a redirect.
      redirect: "manual",
    }),
  );
  if (!policy || !sets || !response.ok) return response;
  return checkTokenResponse(policy, capability, sets, response);
}

/**
 * The gateway's refusal shape (`{ error, code, message }`, the code in
 * `x-everyapp-error`) from the local-dev twin, so {@link gatewayRefusal}
 * reads it the same way.
 */
function devRefusal(status: number, code: string, message: string): Response {
  const labels: Record<number, string> = {
    400: "Bad Request",
    403: "Forbidden",
    502: "Bad Gateway",
  };
  return Response.json(
    { error: labels[status] ?? "Error", code, message },
    { status, headers: { [GATEWAY_ERROR_HEADER]: code } },
  );
}

/** The twin's refusal of a scoped client's grant: the gateway's code and sentence. */
interface DevGrantRefusal {
  code: "capability_not_requested" | "integration_scopes_undeclared";
  problem: string;
}

/**
 * The scope sets the manifest declares for `id`, read from
 * EVERYAPP_DEV_CAPABILITIES (the manifest's `capabilities` as JSON, which
 * `everyAppWorker()` writes in dev), or the gateway's refusal, in its
 * order: the client not listed for writing (`capability_not_requested`),
 * then a void grant (`integration_scopes_undeclared`: the variable
 * missing, the entry without usable `scopes`, or a set this registry
 * doesn't offer). Fails closed like the gateway: a hand-rolled dev harness
 * that passes no capabilities gets nothing.
 */
function devScopeSets(
  policy: OAuthScopePolicy,
  id: OAuthClientCapabilityId,
  label: string,
  values: Record<string, unknown>,
): { sets: string[] } | DevGrantRefusal {
  const offered = Object.keys(policy.sets).join(", ");
  const raw = values["EVERYAPP_DEV_CAPABILITIES"];
  let capabilities: Record<string, unknown> | undefined;
  try {
    capabilities =
      typeof raw === "string" ? jsonRecord(JSON.parse(raw)) : undefined;
  } catch {
    capabilities = undefined;
  }
  if (!capabilities) {
    return {
      code: "integration_scopes_undeclared",
      problem: `${label}'s scope sets aren't known here: everyapp dev passes the manifest's capabilities to the Worker as EVERYAPP_DEV_CAPABILITIES when everyapp.config.ts builds it with everyAppWorker() from @every-app/sdk/cloudflare.`,
    };
  }
  const entry = Object.hasOwn(capabilities, id)
    ? jsonRecord(capabilities[id])
    : undefined;
  // The gateway's check 2: listing the client for writing is the grant.
  if (entry?.["access"] !== "write") {
    return {
      code: "capability_not_requested",
      problem: `This app doesn't list ${label} in its capabilities. Add capabilities: { ${JSON.stringify(id)}: { access: "write" } } to everyapp.config.ts and start everyapp dev again.`,
    };
  }
  const sets = declaredScopeSets(policy, entry);
  if (sets) return { sets };
  const listed = entry["scopes"];
  const unknown = Array.isArray(listed)
    ? listed.filter(
        (name) => typeof name === "string" && !Object.hasOwn(policy.sets, name),
      )
    : [];
  if (unknown.length > 0) {
    return {
      code: "integration_scopes_undeclared",
      problem: `This app's ${label} entry names scope sets this SDK doesn't offer: ${unknown.join(", ")}. It offers: ${offered}. Fix everyapp.config.ts and start everyapp dev again, or update @every-app/sdk if it is older than the set.`,
    };
  }
  return {
    code: "integration_scopes_undeclared",
    problem: `This app lists ${label} without the scope sets it uses. Add scopes: [...] (one or more of: ${offered}) to its ${JSON.stringify(id)} entry in everyapp.config.ts and start everyapp dev again.`,
  };
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The gateway's checks on a token request before it goes out: the grant
 * type must be one the policy completes, and a `scope` the body names must
 * stay within the sets. Null when the request may go.
 */
function refuseTokenRequest(
  policy: OAuthScopePolicy,
  capability: OAuthClientCapability,
  sets: readonly string[],
  request: { url: URL; headers: Headers; body: string | null },
): Response | null {
  const grantType = tokenGrantType(request);
  if (!policy.grantTypes.includes(grantType)) {
    const completes = policy.grantTypes.map((type) =>
      type === null ? "a code exchange without grant_type" : type,
    );
    const asked =
      grantType === null
        ? "a request without grant_type"
        : grantType === "other"
          ? "this request's grant_type"
          : grantType;
    return devRefusal(
      403,
      "integration_grant_not_allowed",
      `Through the gateway, ${capability.label} completes ${completes.join(" and ")} grants only; ${asked} isn't one of them. An app never gets app-level tokens with the operator's client.`,
    );
  }
  const asked = requestedTokenScopes(policy, request);
  const excess = asked ? scopeExcess(asked, allowedScopes(policy, sets)) : [];
  if (excess.length > 0) {
    return devRefusal(
      403,
      "integration_scope_not_allowed",
      `This app may ask ${capability.label} for ${sets.join(", ")} (${requestedScopes(policy, sets).scopes.join(", ")}); the request also asks ${excess.join(", ")}. Build the authorize URL and the token request from integrationStatus().scopes.`,
    );
  }
  return null;
}

/**
 * The gateway's check on a provider's 2xx answer: a token it carries must
 * name scopes, and those must stay within the sets; on a refusal the
 * answer is dropped, never forwarded, so no app holds a token outside its
 * grant. An answer without a token (Slack's `ok: false`) is the app's to
 * read. A non-2xx answer never reaches here.
 */
async function checkTokenResponse(
  policy: OAuthScopePolicy,
  capability: OAuthClientCapability,
  sets: readonly string[],
  response: Response,
): Promise<Response> {
  const invalid = () =>
    devRefusal(
      502,
      "integration_response_invalid",
      `${capability.label} answered with something that isn't a token response (over ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB or not a JSON object); nothing was passed on.`,
    );
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > OAUTH_TOKEN_BODY_LIMIT) return invalid();
  const text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return invalid();
  }
  // The body was decoded on read: its length and encoding headers no
  // longer describe it.
  const headers = new Headers(response.headers);
  for (const name of [
    "set-cookie",
    "content-length",
    "content-encoding",
    "transfer-encoding",
  ]) {
    headers.delete(name);
  }
  const forward = () =>
    new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  if (!carriesToken(json)) return forward();
  const granted = grantedScopes(policy, json);
  if (!granted) {
    return devRefusal(
      502,
      "integration_scope_unverified",
      `${capability.label} issued a token without saying which scopes it carries, so the gateway can't hold it to this app's scope sets; nothing was passed on. Ask the person to connect again.`,
    );
  }
  const excess = scopeExcess(granted, allowedScopes(policy, sets));
  if (excess.length > 0) {
    const remedy = {
      google:
        "Ask for only the scopes integrationStatus() returns, without include_granted_scopes, and connect again; if the app needs more, add the scope set to everyapp.config.ts and deploy.",
      microsoft:
        "On a shared Microsoft client a token carries everything the person consented to this client: have them remove this app's consent at https://myapplications.microsoft.com and connect again, or add the scope set to everyapp.config.ts and deploy.",
      slack:
        "Slack scopes add up per workspace installation: reinstall the app in the workspace with only the status's scopes, or add the scope set to everyapp.config.ts and deploy.",
    }[policy.dialect];
    return devRefusal(
      403,
      "integration_scope_exceeded",
      `${capability.label} granted scopes this app doesn't declare: ${excess.join(", ")}. It declares ${sets.join(", ")} (${requestedScopes(policy, sets).scopes.join(", ")}). Nothing was passed on. ${remedy}`,
    );
  }
  return forward();
}

/** The catalog entry `provider` names, from plain JavaScript or a stale type too; throws for an id the catalog doesn't have. */
function capability(provider: string): Capability {
  const found = CATALOG.get(String(provider));
  if (!found) {
    throw new ConfigurationError(`Unknown capability "${String(provider)}".`);
  }
  return found;
}

/**
 * The provider `integrationFetch()` calls: one whose key or OAuth client
 * the gateway holds, or undefined for an id outside the built-in catalog
 * (a provider registered on the gateway, which the binding resolves).
 */
function fetchableCapability(
  provider: string,
): ApiKeyCapability | OAuthClientCapability | undefined {
  const found = CATALOG.get(String(provider));
  if (!found) return undefined;
  if (found.mode === "service") {
    throw new ConfigurationError(
      `${String(provider)} is a gateway service: call its helper from @every-app/sdk/server (sendEmail(), listMembers()), not integrationFetch().`,
    );
  }
  if (found.mode === "ai") {
    throw new ConfigurationError(
      `${String(provider)} is an AI provider: list it under providers and call it with createGatewayFetch(), not integrationFetch().`,
    );
  }
  return found;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export interface IntegrationStatus {
  /** The app's manifest lists the capability. */
  requested: boolean;
  /** The gateway holds a key for it (in local dev: `.dev.vars` sets one). */
  configured: boolean;
  /** Calls would go through. */
  ready: boolean;
}

/**
 * The email capability's status: as {@link IntegrationStatus}, plus the
 * From a message without `from` gets, the `from` patterns the gateway
 * accepts from this app (its installation's senders, `everyapp email set
 * --sender`) and the provider mail goes out with (`cloudflare` or `resend`).
 */
export type EmailIntegrationStatus = IntegrationStatus &
  Pick<EmailCapabilityStatus, "sender" | "senders" | "provider">;

/**
 * An OAuth client's status: as {@link IntegrationStatus}, plus what the app
 * needs to send people to the provider's authorize page, present only when
 * the app lists the capability and the gateway holds the client.
 */
export interface OAuthClientIntegrationStatus extends IntegrationStatus {
  /** The client's public id, for the authorize URL (and Twitch's `Client-Id`). */
  clientId?: string;
  /**
   * The provider's origin when the operator chose it (Mastodon's instance,
   * `MASTODON_URL`): the authorize page, token endpoint and API are on it.
   */
  origin?: string;
  /**
   * For a client with scope sets (`google-workspace`, `microsoft-365`): the
   * set names the app's manifest entry declares, `[]` when the entry voids
   * its grant (no `scopes`, or a set this gateway doesn't offer), in which
   * case `ready` is false and no token call can complete.
   */
  scopeSets?: readonly string[];
  /**
   * The provider's scope strings those sets ask for, in the provider's
   * spelling and the registry's order, for the authorize URL
   * ({@link authorizeUrl} puts them on). The gateway refuses a token that
   * carries more.
   */
  scopes?: readonly string[];
  /** Slack's `user_scope` strings, when the sets name any. */
  userScopes?: readonly string[];
}

/** The status of a capability: email's carries its senders, an OAuth client's its id. */
export type IntegrationStatusOf<P extends string> = P extends "email"
  ? EmailIntegrationStatus
  : P extends OAuthClientCapabilityId
    ? OAuthClientIntegrationStatus
    : IntegrationStatus;

/**
 * Whether the app can use an integration right now, without calling the
 * provider: show "an admin needs to set up DataForSEO" (or "sending isn't
 * set up") up front instead of failing mid-task. An OAuth client's status
 * carries its public `clientId` for the authorize URL.
 */
export async function integrationStatus<
  P extends CapabilityId | (string & {}),
>({
  env,
  provider,
}: {
  env: object;
  provider: P;
}): Promise<IntegrationStatusOf<P>> {
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  // A provider registered on the gateway is the gateway's to answer for;
  // without one, only the catalog is known here.
  const integration =
    binding && typeof binding.fetch === "function"
      ? CATALOG.get(String(provider))
      : capability(provider);
  if (integration?.mode === "ai") {
    throw new ConfigurationError(
      `${String(provider)} is an AI provider: it has no integration status (createGatewayFetch() answers ai_provider_not_configured when its key is unset).`,
    );
  }
  const unavailable = (): IntegrationStatusOf<P> =>
    (provider === "email"
      ? {
          requested: false,
          configured: false,
          ready: false,
          sender: null,
          senders: [],
          provider: null,
        }
      : {
          requested: false,
          configured: false,
          ready: false,
        }) as IntegrationStatusOf<P>;
  if (binding && typeof binding.fetch === "function") {
    const response = await binding.fetch(
      `${BINDING_ORIGIN}${INTEGRATION_PROXY_PREFIX}/${provider}`,
    );
    if (!response.ok) return unavailable();
    return (await response.json()) as IntegrationStatusOf<P>;
  }
  if (!integration) return unavailable();
  if (integration.mode === "service") {
    if (provider === "email") {
      return devEmailStatus(values) as IntegrationStatusOf<P>;
    }
    // Members: listMembers() answers from the dev identity, nothing to set.
    const dev = Boolean(values["EVERYAPP_DEV"]);
    return {
      requested: true,
      configured: dev,
      ready: dev,
    } as IntegrationStatusOf<P>;
  }
  if (integration.mode === "oauth_client") {
    return devOAuthClientStatus(
      provider as OAuthClientCapabilityId,
      integration,
      values,
    ) as IntegrationStatusOf<P>;
  }
  const configured = Boolean(
    values["EVERYAPP_DEV"] && authorizationFor(integration, values),
  );
  return {
    requested: true,
    configured,
    ready: configured,
  } as IntegrationStatusOf<P>;
}

/**
 * An OAuth client in local dev, with no gateway: the developer's own, from
 * `.dev.vars`, and for a client with scope sets the manifest's, from
 * EVERYAPP_DEV_CAPABILITIES, shaped as the gateway's status is: an app
 * that doesn't list the client is told nothing, and a void grant is not
 * ready and hides the client id.
 */
function devOAuthClientStatus(
  id: OAuthClientCapabilityId,
  capability: OAuthClientCapability,
  values: Record<string, unknown>,
): OAuthClientIntegrationStatus {
  const client = values["EVERYAPP_DEV"]
    ? oauthClientCredentials(capability, values)
    : null;
  const origin = oauthClientOrigin(capability, values);
  const policy = capability.scopePolicy;
  const grant = policy
    ? devScopeSets(policy, id, capability.label, values)
    : null;
  if (grant && "problem" in grant) {
    if (grant.code === "capability_not_requested") {
      return { requested: false, configured: false, ready: false };
    }
    return {
      requested: true,
      configured: Boolean(client),
      ready: false,
      scopeSets: [],
    };
  }
  const asked = policy && grant ? requestedScopes(policy, grant.sets) : null;
  return {
    requested: true,
    configured: Boolean(client),
    ready: Boolean(client),
    ...(client ? { clientId: client.clientId } : {}),
    ...(client && origin ? { origin } : {}),
    ...(client && grant && asked
      ? {
          scopeSets: grant.sets,
          scopes: asked.scopes,
          ...(asked.userScopes.length > 0
            ? { userScopes: asked.userScopes }
            : {}),
        }
      : {}),
  };
}

/**
 * Email in local dev, with no gateway: sends are printed unless `.dev.vars`
 * sets EMAIL_FROM (and the REST settings), and the senders are the ones
 * `.dev.vars` sets as EVERYAPP_EMAIL_SENDERS, standing in for the
 * installation's (`everyapp email set --sender`); unset, none. The
 * provider is the one the gateway would pick from the same settings:
 * `cloudflare` for the REST pair, `resend` for RESEND_API_KEY, EMAIL_PROVIDER
 * choosing when both are set.
 */
function devEmailStatus(
  values: Record<string, unknown>,
): EmailIntegrationStatus {
  const dev = Boolean(values["EVERYAPP_DEV"]);
  const configured = dev && Boolean(stringValue(values["EMAIL_FROM"]));
  const choice = chooseEmailProvider(values["EMAIL_PROVIDER"], (provider) =>
    (
      provider === "cloudflare"
        ? stringValue(values["EMAIL_REST_API_TOKEN"]) &&
          stringValue(values["CLOUDFLARE_ACCOUNT_ID"])
        : stringValue(values["RESEND_API_KEY"])
    )
      ? "settings"
      : null,
  );
  return {
    requested: true,
    configured,
    ready: configured,
    sender: configured
      ? parseEmailSender(
          stringValue(values["EMAIL_FROM"]),
          stringValue(values["EMAIL_FROM_NAME"]),
        )
      : null,
    senders: dev ? parseEmailList(values[EMAIL_SENDERS_ENV]) : [],
    provider: configured && choice.ok ? choice.provider : null,
  };
}

/** A refusal the AppGateway binding made itself, not the provider. */
export interface GatewayRefusal {
  status: number;
  /** e.g. `capability_not_requested`, `integration_not_configured`. */
  code: string;
  message: string;
}

/**
 * A refusal the AppGateway binding made, thrown: what `sendEmail()` throws
 * when the gateway won't send (`email_sender_not_allowed`,
 * `email_budget_exhausted`, ...). The thrown twin of {@link gatewayRefusal}.
 */
export class GatewayRefusalError extends Error implements GatewayRefusal {
  readonly status: number;
  readonly code: string;

  constructor({ status, code, message }: GatewayRefusal) {
    super(message);
    this.name = "GatewayRefusalError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The gateway's own refusal in `response`, or null when the response is the
 * provider's answer (which may be an error of its own). Reads the body only
 * for a refusal, so call it before reading the body yourself.
 */
export async function gatewayRefusal(
  response: Response,
): Promise<GatewayRefusal | null> {
  const code = response.headers.get(GATEWAY_ERROR_HEADER);
  if (!code) return null;
  const body: unknown = await response.json().catch(() => null);
  const message =
    body &&
    typeof body === "object" &&
    typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : `The Every App gateway refused the call (${code}).`;
  return { status: response.status, code, message };
}
