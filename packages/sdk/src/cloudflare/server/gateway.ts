const SERVICE_BINDING_ORIGIN = "http://localhost";
const APP_TOKEN_HEADER = "x-every-app-token";

interface GatewayFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface GatewayEnv {
  GATEWAY_URL?: string;
  EVERY_APP_GATEWAY?: GatewayFetcher;
  GATEWAY_APP_API_TOKEN?: string;
  APP_TOKEN?: string;
}

interface FetchGatewayOptions {
  env: GatewayEnv;
  /** The URL, path, or Request to send to the gateway. Typically the full URL
   *  passed by a provider SDK's custom `fetch` override. */
  url: string | URL | Request;
  /** Standard `RequestInit` (method, headers, body, etc.) from the provider SDK. */
  init?: RequestInit;
}

export function getGatewayUrl(env: GatewayEnv): string {
  const gatewayUrl = env.GATEWAY_URL?.trim();
  if (!gatewayUrl) {
    throw new Error("GATEWAY_URL is required");
  }
  return gatewayUrl;
}

/**
 * Fetch from the gateway proxy, authenticating with the app token.
 *
 * - Strips any existing `Authorization` header (the gateway only accepts
 *   app token auth via `x-every-app-token`).
 * - Requires `GATEWAY_APP_API_TOKEN` (or legacy `APP_TOKEN`) in the env.
 * - Routes via service binding in production, falls back to HTTP in dev.
 */
export async function fetchGateway({
  env,
  url,
  init,
}: FetchGatewayOptions): Promise<Response> {
  const gatewayBaseUrl = getGatewayUrl(env);
  const resolvedRequest = toRequest(url, init, gatewayBaseUrl);
  const authenticatedRequest = applyAppTokenAuth(resolvedRequest, env);

  // Use service binding when available for zero-latency internal routing
  // (available in production Workers, not in local dev)
  if (env.EVERY_APP_GATEWAY) {
    const url = new URL(authenticatedRequest.url);
    const bindingUrl = `${SERVICE_BINDING_ORIGIN}${url.pathname}${url.search}`;
    const bindingRequest = new Request(bindingUrl, authenticatedRequest);
    return env.EVERY_APP_GATEWAY.fetch(bindingRequest);
  }

  // Fall back to HTTP fetch for local dev
  return fetch(authenticatedRequest);
}

function applyAppTokenAuth(request: Request, env: GatewayEnv): Request {
  const appToken = getGatewayAppApiToken(env);
  if (!appToken) {
    throw new Error(
      "GATEWAY_APP_API_TOKEN is required. Run `npx everyapp app deploy` to provision one.",
    );
  }

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set(APP_TOKEN_HEADER, appToken);
  return new Request(request, { headers });
}

function getGatewayAppApiToken(env: GatewayEnv): string | null {
  const configuredToken = env.GATEWAY_APP_API_TOKEN?.trim();
  if (configuredToken) {
    return configuredToken;
  }

  const legacyToken = env.APP_TOKEN?.trim();
  return legacyToken || null;
}

function toRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
  baseUrl?: string,
): Request {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }

  if (input instanceof URL) {
    return new Request(input.toString(), init);
  }

  if (typeof input === "string" && baseUrl && !/^https?:\/\//i.test(input)) {
    const normalizedPath = input.startsWith("/") ? input : `/${input}`;
    return new Request(new URL(normalizedPath, baseUrl).toString(), init);
  }

  return new Request(input, init);
}
