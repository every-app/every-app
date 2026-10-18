import {
  CAPABILITIES,
  ConfigurationError,
  GATEWAY_ERROR_HEADER,
  INTEGRATION_PROXY_PREFIX,
  OAUTH_TOKEN_BODY_LIMIT,
  capabilitySettings,
  describeTokenEndpoints,
  injectClientCredentials,
  integrationProxyPath,
  oauthClientCredentials,
  oauthClientOrigin,
  tokenEndpointFor,
  type ApiKeyCapability,
  type ApiKeyCapabilityId,
  type Capability,
  type CapabilityId,
  type EmailCapabilityStatus,
  type OAuthClientCapability,
  type OAuthClientCapabilityId,
  type OAuthClientCredentials,
  EMAIL_SENDERS_ENV,
  chooseEmailProvider,
  parseEmailSender,
  parseEmailSendersEnv,
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
   * endpoints only). The `email` capability is sent with `sendEmail()`
   * instead.
   */
  provider: ApiKeyCapabilityId | OAuthClientCapabilityId;
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
 * `client_secret`. Build the authorize URL from {@link integrationStatus}'s
 * `clientId`, and call the provider's API with the user's token directly.
 *
 * In local dev only, with no binding, the developer's own key or client
 * from `.dev.vars` reaches the provider directly, under the gateway's names.
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
  const local = binding ? null : localCredentials(integration, values);
  if (!binding && !local) {
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
    headers.set("authorization", integration.authorization(local as string));
    return fetch(streamingRequest(upstream.toString(), outbound, headers));
  };
}

/**
 * The developer's own key or client from `.dev.vars` (with EVERYAPP_DEV
 * set), under the gateway's names; null until every setting it needs is.
 */
function localCredentials(
  integration: ApiKeyCapability | OAuthClientCapability,
  values: Record<string, unknown>,
): string | OAuthClientCredentials | null {
  if (!values["EVERYAPP_DEV"]) return null;
  if (integration.mode === "oauth_client") {
    return oauthClientCredentials(integration, values);
  }
  return stringValue(values[integration.secret]) ?? null;
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
  const body = method === "GET" ? null : await outbound.text();
  if (
    body !== null &&
    new TextEncoder().encode(body).byteLength > OAUTH_TOKEN_BODY_LIMIT
  ) {
    throw new TypeError(
      `A token request's body is at most ${OAUTH_TOKEN_BODY_LIMIT / 1024} KiB.`,
    );
  }
  const injected = injectClientCredentials(
    { url: upstream, headers, body },
    endpoint,
    client as OAuthClientCredentials,
  );
  if (!injected.ok) throw new TypeError(injected.problem);
  return fetch(
    new Request(injected.url, {
      method,
      headers: injected.headers,
      body: injected.body,
      signal: outbound.signal,
      // As the gateway: the client never follows a redirect.
      redirect: "manual",
    }),
  );
}

/** The capability `provider` names, from plain JavaScript or a stale type too. */
function capability(provider: CapabilityId): Capability {
  if (!Object.hasOwn(CAPABILITIES, provider)) {
    throw new ConfigurationError(`Unknown capability "${String(provider)}".`);
  }
  return CAPABILITIES[provider];
}

/** The provider `integrationFetch()` calls: one whose key or OAuth client the gateway holds. */
function fetchableCapability(
  provider: ApiKeyCapabilityId | OAuthClientCapabilityId,
): ApiKeyCapability | OAuthClientCapability {
  const found = capability(provider);
  if (found.mode === "service") {
    throw new ConfigurationError(
      `${String(provider)} is sent with sendEmail() from @every-app/sdk/server, not integrationFetch().`,
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
 * accepts from this app (its manifest's `capabilities.email.senders`) and
 * the provider mail goes out with (`cloudflare` or `resend`).
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
}

/** The status of a capability: email's carries its senders, an OAuth client's its id. */
export type IntegrationStatusOf<P extends CapabilityId> = P extends "email"
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
export async function integrationStatus<P extends CapabilityId>({
  env,
  provider,
}: {
  env: object;
  provider: P;
}): Promise<IntegrationStatusOf<P>> {
  const integration = capability(provider);
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  const unavailable = (): IntegrationStatusOf<P> =>
    (integration.mode === "service"
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
  if (integration.mode === "service") {
    return devEmailStatus(values) as IntegrationStatusOf<P>;
  }
  if (integration.mode === "oauth_client") {
    return devOAuthClientStatus(integration, values) as IntegrationStatusOf<P>;
  }
  const configured = Boolean(
    values["EVERYAPP_DEV"] && stringValue(values[integration.secret]),
  );
  return {
    requested: true,
    configured,
    ready: configured,
  } as IntegrationStatusOf<P>;
}

/** An OAuth client in local dev, with no gateway: the developer's own, from `.dev.vars`. */
function devOAuthClientStatus(
  capability: OAuthClientCapability,
  values: Record<string, unknown>,
): OAuthClientIntegrationStatus {
  const client = values["EVERYAPP_DEV"]
    ? oauthClientCredentials(capability, values)
    : null;
  const origin = oauthClientOrigin(capability, values);
  return {
    requested: true,
    configured: Boolean(client),
    ready: Boolean(client),
    ...(client ? { clientId: client.clientId } : {}),
    ...(client && origin ? { origin } : {}),
  };
}

/**
 * Email in local dev, with no gateway: sends are printed unless `.dev.vars`
 * sets EMAIL_FROM (and the REST settings), and the senders are the
 * manifest's, which `everyAppWorker()` passes in EVERYAPP_EMAIL_SENDERS.
 * The provider is the one the gateway would pick from the same settings:
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
    senders: dev ? parseEmailSendersEnv(values[EMAIL_SENDERS_ENV]) : [],
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
