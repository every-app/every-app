import {
  APP_TOKEN_HEADER,
  GatewayAuthError,
  type GatewayAuthContext,
} from "./gateway-auth-policy";

const OPENAI_PROVIDER = "openai";
const OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com";
const STRIPPED_PROXY_HEADERS = [
  APP_TOKEN_HEADER,
  "x-user-id",
  "x-user-email",
  "x-user-sub",
  "cookie",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
];

interface AiProxyEnv {
  OPENAI_API_KEY?: string;
}

interface HandleAiProxyRequestOptions {
  request: Request;
  provider: string;
  env: AiProxyEnv;
  authenticate: (options: {
    request: Request;
    provider: string;
  }) => Promise<GatewayAuthContext>;
  fetchUpstream?: (request: Request) => Promise<Response>;
}

export async function handleAiProxyRequest({
  request,
  provider,
  env,
  authenticate,
  fetchUpstream = fetch,
}: HandleAiProxyRequestOptions): Promise<Response> {
  if (provider !== OPENAI_PROVIDER) {
    return jsonResponse({ error: "Provider not supported" }, 404);
  }

  try {
    await authenticate({
      request,
      provider,
    });
  } catch (error) {
    if (error instanceof GatewayAuthError) {
      return jsonResponse(
        {
          error: error.status === 403 ? "Forbidden" : "Unauthorized",
          code: error.code,
        },
        error.status,
      );
    }

    console.error("AI proxy authentication failure:", error);
    return jsonResponse({ error: "Failed to authenticate request" }, 500);
  }

  if (!env.OPENAI_API_KEY?.trim()) {
    return jsonResponse({ error: "Provider is not configured" }, 503);
  }

  const upstreamUrl = buildOpenAiUpstreamUrl(request, provider);
  if (!upstreamUrl) {
    return jsonResponse({ error: "Invalid proxy request path" }, 400);
  }

  const requestHeaders = new Headers(request.headers);
  stripProxyHeaders(requestHeaders);
  requestHeaders.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);

  const requestBody = canIncludeBody(request.method)
    ? await request.clone().arrayBuffer()
    : undefined;

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: requestHeaders,
    body: requestBody,
  });

  try {
    return await fetchUpstream(upstreamRequest);
  } catch (error) {
    console.error("AI proxy upstream failure:", error);
    return jsonResponse({ error: "Upstream provider request failed" }, 502);
  }
}

function buildOpenAiUpstreamUrl(
  request: Request,
  provider: string,
): string | null {
  const incomingUrl = new URL(request.url);
  const routePrefix = `/api/ai/${provider}`;

  if (!matchesProviderRoute(incomingUrl.pathname, routePrefix)) {
    return null;
  }

  const upstreamPath = incomingUrl.pathname.slice(routePrefix.length) || "/";
  if (!isSafeUpstreamPath(upstreamPath)) {
    return null;
  }

  const upstreamUrl = new URL(OPENAI_UPSTREAM_BASE_URL);
  upstreamUrl.pathname = upstreamPath;
  upstreamUrl.search = incomingUrl.search;

  return upstreamUrl.toString();
}

function matchesProviderRoute(pathname: string, routePrefix: string): boolean {
  return pathname === routePrefix || pathname.startsWith(`${routePrefix}/`);
}

function isSafeUpstreamPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) {
    return false;
  }

  if (pathname.startsWith("//")) {
    return false;
  }

  return !pathname.includes("\\");
}

function stripProxyHeaders(headers: Headers): void {
  for (const header of STRIPPED_PROXY_HEADERS) {
    headers.delete(header);
  }
}

function canIncludeBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
