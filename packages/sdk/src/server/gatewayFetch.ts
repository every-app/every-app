import {
  ConfigurationError,
  DEV_AI_PROVIDERS,
  devAiProvider,
  IDENTITY_HEADER,
} from "../internal/index.js";

export const BINDING_ORIGIN = "http://every-app-gateway.internal";
const AI_PROXY_PREFIX = "/api/ai/";

export interface GatewayServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface GatewayFetchEnv {
  EVERY_APP_GATEWAY?: GatewayServiceBinding;
  EVERYAPP_DEV?: string | boolean;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

export interface CreateGatewayFetchOptions {
  env: GatewayFetchEnv;
  /**
   * The inbound app request whose verified identity is forwarded, so the
   * gateway attributes the call to its user. Omit it for work no person
   * started (crons, workflows, queues): the call is attributed to the app.
   */
  request?: Request;
}

/**
 * Create a fetch for the gateway's AI providers (`/api/ai/<provider>/…`),
 * backed by the private gateway service binding. In local dev only, the
 * developer's own provider key from `.dev.vars` is a direct-provider
 * fallback when no binding exists.
 */
export function createGatewayFetch({
  env,
  request: inboundRequest,
}: CreateGatewayFetchOptions): typeof fetch {
  const binding = env.EVERY_APP_GATEWAY;
  const devKeys = env.EVERYAPP_DEV ? localProviderKeys(env) : {};

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!binding && Object.keys(devKeys).length === 0) {
    throw new ConfigurationError(
      "AI gateway unavailable: deploy with the EVERY_APP_GATEWAY binding, or set the provider's key (OPENAI_API_KEY, OPENROUTER_API_KEY) in .dev.vars for direct local development.",
    );
  }

  return async (input, init) => {
    const outbound = new Request(input, init);
    const headers = new Headers(outbound.headers);
    headers.delete("authorization");

    if (binding) {
      const identity = inboundRequest?.headers.get(IDENTITY_HEADER);
      if (identity) headers.set(IDENTITY_HEADER, identity);
      else headers.delete(IDENTITY_HEADER);
      const target = new URL(outbound.url);
      const bindingRequest = streamingRequest(
        `${BINDING_ORIGIN}${target.pathname}${target.search}`,
        outbound,
        headers,
      );
      return binding.fetch(bindingRequest);
    }

    const { url, provider } = directProviderUrl(outbound.url);
    const devKey = devKeys[provider];
    if (!devKey) {
      throw new ConfigurationError(
        `Set ${devAiProvider(provider)?.keyEnv} in .dev.vars to call ${provider} in local development.`,
      );
    }
    headers.delete(IDENTITY_HEADER);
    headers.set("authorization", `Bearer ${devKey}`);
    return fetch(streamingRequest(url, outbound, headers));
  };
}

/** A copy of `source` aimed at `url`, streaming its body rather than buffering it. */
export function streamingRequest(
  url: string,
  source: Request,
  headers: Headers,
): Request {
  const body = canIncludeBody(source.method) ? source.body : undefined;
  const init: RequestInit & { duplex?: "half" } = {
    method: source.method,
    headers,
    body,
    signal: source.signal,
    ...(body ? { duplex: "half" } : {}),
  };
  return new Request(url, init);
}

function localProviderKeys(env: GatewayFetchEnv): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const [provider, { keyEnv }] of Object.entries(DEV_AI_PROVIDERS)) {
    const value = (env as Record<string, unknown>)[keyEnv];
    if (typeof value === "string" && value.trim())
      keys[provider] = value.trim();
  }
  return keys;
}

function directProviderUrl(input: string): { url: string; provider: string } {
  const incoming = new URL(input);
  const match = incoming.pathname.match(
    /^\/api\/ai\/([a-z][a-z0-9-]*)(\/.*)?$/,
  );
  const provider = match?.[1];
  const devProvider = provider ? devAiProvider(provider) : undefined;
  if (!provider || !devProvider) {
    throw new ConfigurationError(
      `Direct local provider fallback only supports ${Object.keys(
        DEV_AI_PROVIDERS,
      )
        .map((name) => `${AI_PROXY_PREFIX}${name}`)
        .join(" and ")} paths.`,
    );
  }

  const upstreamPath = match?.[2] || "/";
  if (upstreamPath.startsWith("//") || upstreamPath.includes("\\")) {
    throw new ConfigurationError("Invalid provider proxy path.");
  }

  const upstream = new URL(devProvider.origin);
  upstream.pathname = upstreamPath;
  upstream.search = incoming.search;
  return { url: upstream.toString(), provider };
}

function canIncludeBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
