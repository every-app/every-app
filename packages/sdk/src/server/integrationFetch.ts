import {
  CAPABILITIES,
  ConfigurationError,
  GATEWAY_ERROR_HEADER,
  INTEGRATION_PROXY_PREFIX,
  integrationProxyPath,
  type CapabilityId,
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
  /** A capability the app lists in its manifest's `capabilities`. */
  provider: CapabilityId;
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
 * In local dev only, with no binding, the developer's own key from
 * `.dev.vars` reaches the provider directly.
 */
export function integrationFetch({
  env,
  provider,
  for: target,
}: IntegrationFetchOptions): typeof fetch {
  const integration = capability(provider);
  checkAttribution(env, target, `integrationFetch("${provider}")`);
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  const devKey = values["EVERYAPP_DEV"]
    ? stringValue(values[integration.secret])
    : undefined;

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!binding && !devKey) {
    throw new ConfigurationError(
      `${integration.label} is unavailable: deploy with the EVERY_APP_GATEWAY binding, or set ${integration.secret} in .dev.vars for local development.`,
    );
  }

  return async (input, init) => {
    const outbound = new Request(input, init);
    const upstream = new URL(outbound.url);
    if (
      upstream.protocol !== "https:" ||
      !(integration.hosts as readonly string[]).includes(upstream.host)
    ) {
      throw new TypeError(
        `integrationFetch("${provider}") only reaches ${integration.hosts.join(", ")}, not ${upstream.host}.`,
      );
    }

    const headers = new Headers(outbound.headers);
    headers.delete("authorization");
    headers.delete("cookie");

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
    headers.set("authorization", integration.authorization(devKey as string));
    return fetch(streamingRequest(upstream.toString(), outbound, headers));
  };
}

/** The capability `provider` names, from plain JavaScript or a stale type too. */
function capability(provider: CapabilityId) {
  if (!Object.hasOwn(CAPABILITIES, provider)) {
    throw new ConfigurationError(`Unknown capability "${String(provider)}".`);
  }
  return CAPABILITIES[provider];
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
 * Whether the app can use an integration right now, without calling the
 * provider: show "an admin needs to set up DataForSEO" up front instead of
 * failing mid-task.
 */
export async function integrationStatus({
  env,
  provider,
}: Pick<
  IntegrationFetchOptions,
  "env" | "provider"
>): Promise<IntegrationStatus> {
  const integration = capability(provider);
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  if (binding && typeof binding.fetch === "function") {
    const response = await binding.fetch(
      `${BINDING_ORIGIN}${INTEGRATION_PROXY_PREFIX}/${provider}`,
    );
    if (!response.ok) {
      return { requested: false, configured: false, ready: false };
    }
    return (await response.json()) as IntegrationStatus;
  }
  const configured = Boolean(
    values["EVERYAPP_DEV"] && stringValue(values[integration.secret]),
  );
  return { requested: true, configured, ready: configured };
}

/** A refusal the AppGateway binding made itself, not the provider. */
export interface GatewayRefusal {
  status: number;
  /** e.g. `capability_not_requested`, `integration_not_configured`. */
  code: string;
  message: string;
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
