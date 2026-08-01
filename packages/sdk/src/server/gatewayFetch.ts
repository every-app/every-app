import { ConfigurationError, IDENTITY_HEADER } from "../internal/index.js";

const BINDING_ORIGIN = "http://every-app-gateway.internal";
const OPENAI_UPSTREAM_ORIGIN = "https://api.openai.com";
const OPENAI_PROXY_PREFIX = "/api/ai/openai";

interface GatewayServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface GatewayFetchEnv {
  EVERY_APP_GATEWAY?: GatewayServiceBinding;
  EVERYAPP_DEV?: string | boolean;
  OPENAI_API_KEY?: string;
}

export interface CreateGatewayFetchOptions {
  env: GatewayFetchEnv;
  /** The inbound app request whose verified identity may be forwarded. */
  request: Request;
}

/**
 * Create an OpenAI-compatible fetch function backed by the private gateway
 * service binding. In local dev only, the developer's own OPENAI_API_KEY is a
 * direct-provider fallback when no binding exists.
 */
export function createGatewayFetch({
  env,
  request: inboundRequest,
}: CreateGatewayFetchOptions): typeof fetch {
  const binding = env.EVERY_APP_GATEWAY;
  const devProviderKey = env.EVERYAPP_DEV
    ? env.OPENAI_API_KEY?.trim()
    : undefined;

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!binding && !devProviderKey) {
    throw new ConfigurationError(
      "AI gateway unavailable: deploy with the EVERY_APP_GATEWAY binding, or set OPENAI_API_KEY in .dev.vars for direct local development.",
    );
  }

  return async (input, init) => {
    const outbound = new Request(input, init);
    const headers = new Headers(outbound.headers);
    headers.delete("authorization");

    const identity = inboundRequest.headers.get(IDENTITY_HEADER);
    if (identity) headers.set(IDENTITY_HEADER, identity);
    else headers.delete(IDENTITY_HEADER);

    if (binding) {
      const target = new URL(outbound.url);
      const bindingRequest = streamingRequest(
        `${BINDING_ORIGIN}${target.pathname}${target.search}`,
        outbound,
        headers,
      );
      return binding.fetch(bindingRequest);
    }

    const providerUrl = directOpenAiUrl(outbound.url);
    headers.delete(IDENTITY_HEADER);
    headers.set("authorization", `Bearer ${devProviderKey}`);
    return fetch(streamingRequest(providerUrl, outbound, headers));
  };
}

function streamingRequest(
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

function directOpenAiUrl(input: string): string {
  const incoming = new URL(input);
  if (
    incoming.pathname !== OPENAI_PROXY_PREFIX &&
    !incoming.pathname.startsWith(`${OPENAI_PROXY_PREFIX}/`)
  ) {
    throw new ConfigurationError(
      `Direct local provider fallback only supports ${OPENAI_PROXY_PREFIX} paths.`,
    );
  }

  const upstreamPath =
    incoming.pathname.slice(OPENAI_PROXY_PREFIX.length) || "/";
  if (!upstreamPath.startsWith("/") || upstreamPath.startsWith("//")) {
    throw new ConfigurationError("Invalid OpenAI proxy path.");
  }

  const upstream = new URL(OPENAI_UPSTREAM_ORIGIN);
  upstream.pathname = upstreamPath;
  upstream.search = incoming.search;
  return upstream.toString();
}

function canIncludeBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
