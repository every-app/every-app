import { IDENTITY_HEADER, PUBLIC_HEADER } from "@every-app/sdk/internal";

const OPENAI_PROVIDER = "openai";
const OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com";
const STRIPPED_PROXY_HEADERS = [
  "x-every-app-token",
  IDENTITY_HEADER,
  PUBLIC_HEADER,
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

interface HandleAuthenticatedAiProxyRequestOptions {
  request: Request;
  provider: string;
  env: AiProxyEnv;
  fetchUpstream?: (request: Request) => Promise<Response>;
}

/**
 * Forward a request whose caller has already been authenticated by its
 * service-binding transport boundary.
 */
export async function handleAuthenticatedAiProxyRequest({
  request,
  provider,
  env,
  fetchUpstream = fetch,
}: HandleAuthenticatedAiProxyRequestOptions): Promise<Response> {
  if (provider !== OPENAI_PROVIDER) {
    return jsonResponse({ error: "Provider not supported" }, 404);
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

  const requestBody = canIncludeBody(request.method) ? request.body : undefined;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: requestHeaders,
    body: requestBody,
    signal: request.signal,
    ...(requestBody ? { duplex: "half" } : {}),
  };
  const upstreamRequest = new Request(upstreamUrl, requestInit);

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
