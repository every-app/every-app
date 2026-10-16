import { IDENTITY_HEADER, PUBLIC_HEADER } from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { AiPolicy } from "@every-app/perimeter/manifest";
import { tapUsage } from "./ai-usage";

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
  // Provider credentials and account selectors: the gateway's key decides
  // the account, never the app.
  "x-api-key",
  "openai-organization",
  "openai-project",
];
// Every gateway trust header, and AI Gateway's (cf-aig-*), which would let
// an app pick a gateway's cache, logging or metadata.
const STRIPPED_PROXY_HEADER_PREFIXES = ["x-everyapp-", "cf-aig-"];

interface AiProvider {
  upstreamBaseUrl: string;
  /** The gateway secret holding the provider key. */
  keyEnv: "OPENAI_API_KEY" | "OPENROUTER_API_KEY";
  /**
   * The one key is shared by every app in every organization, and providers
   * keep files, batches, fine-tunes and stored completions per account, so
   * any other endpoint would let one app read another's data or start
   * expensive jobs. Apps get inference only (POST to these exact paths).
   */
  inferenceRoutes: ReadonlySet<string>;
  /** Inference results the provider keeps account-wide unless told not to. */
  unstoredRoutes: ReadonlySet<string>;
  /**
   * More than inference needs both the operator (AI_PROXY_EXTRA_ROUTES) and
   * the app's manifest (`ai.routes`): whoever can deploy an app writes its
   * manifest. OpenAI paths only.
   */
  extraRoutes: boolean;
}

const AI_PROVIDERS: Record<string, AiProvider> = {
  openai: {
    upstreamBaseUrl: "https://api.openai.com",
    keyEnv: "OPENAI_API_KEY",
    inferenceRoutes: new Set([
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/audio/speech",
      "/v1/audio/transcriptions",
      "/v1/audio/translations",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/images/variations",
    ]),
    unstoredRoutes: new Set(["/v1/responses", "/v1/chat/completions"]),
    extraRoutes: true,
  },
  // OpenAI-compatible, in front of many model providers. Usage (with cost)
  // comes back in the response, so apps can meter their own spend.
  openrouter: {
    upstreamBaseUrl: "https://openrouter.ai",
    keyEnv: "OPENROUTER_API_KEY",
    inferenceRoutes: new Set([
      "/api/v1/chat/completions",
      "/api/v1/completions",
      "/api/v1/responses",
      "/api/v1/embeddings",
    ]),
    unstoredRoutes: new Set(),
    extraRoutes: false,
  },
};

interface AiProxyEnv {
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /**
   * OpenAI paths beyond inference that apps may use, set by the operator
   * (comma or space separated, e.g. "/v1/files"). Each also covers its
   * sub-paths. An app still has to list a path in its manifest's `ai.routes`.
   */
  AI_PROXY_EXTRA_ROUTES?: string;
}

// The same shape the manifest accepts for `ai.routes`.
const AI_ROUTE_PATTERN = /^\/v1(\/[a-z0-9_-]+)+$/;

interface HandleAuthenticatedAiProxyRequestOptions {
  request: Request;
  provider: string;
  env: AiProxyEnv;
  /** The calling app's manifest `ai` policy. */
  policy?: AiPolicy;
  /** Who is calling, for the usage log line. */
  caller?: { organizationId: string; appId: string };
  fetchUpstream?: (request: Request) => Promise<Response>;
}

type PreparedBody =
  | { ok: true; body: BodyInit | null; model: string | null }
  | { ok: false; response: Response };

/**
 * Forward a request whose caller has already been authenticated by its
 * service-binding transport boundary.
 */
export async function handleAuthenticatedAiProxyRequest({
  request,
  provider,
  env,
  policy,
  caller,
  fetchUpstream = fetch,
}: HandleAuthenticatedAiProxyRequestOptions): Promise<Response> {
  const aiProvider = Object.hasOwn(AI_PROVIDERS, provider)
    ? AI_PROVIDERS[provider]
    : undefined;
  if (!aiProvider) {
    return jsonResponse({ error: "Provider not supported" }, 404);
  }

  const providerKey = env[aiProvider.keyEnv]?.trim();
  if (!providerKey) {
    return jsonResponse({ error: "Provider is not configured" }, 503);
  }

  const upstreamUrl = buildUpstreamUrl(request, provider, aiProvider);
  if (!upstreamUrl) {
    return jsonResponse({ error: "Invalid proxy request path" }, 400);
  }
  const upstreamPath = new URL(upstreamUrl).pathname;

  if (
    !isAllowedRoute(
      aiProvider,
      request.method,
      upstreamPath,
      policy,
      operatorRoutes(env.AI_PROXY_EXTRA_ROUTES),
    )
  ) {
    return jsonResponse(
      {
        error: "This provider endpoint is not available to apps",
        code: "ai_route_not_allowed",
      },
      403,
    );
  }

  const requestHeaders = new Headers(request.headers);
  stripProxyHeaders(requestHeaders);
  requestHeaders.set("authorization", `Bearer ${providerKey}`);

  const prepared = await prepareBody(
    aiProvider,
    request,
    upstreamPath,
    requestHeaders,
  );
  if (!prepared.ok) return prepared.response;

  // The model allowlist covers inference, where the gateway reads the model.
  // Endpoints an app opted into with `ai.routes` stream through unread.
  if (
    policy?.models &&
    aiProvider.inferenceRoutes.has(upstreamPath) &&
    !policy.models.includes(prepared.model ?? "")
  ) {
    return jsonResponse(
      {
        error: "The app manifest does not allow this model",
        code: "model_not_allowed",
      },
      403,
    );
  }

  const requestBody = prepared.body;
  const requestInit: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers: requestHeaders,
    body: requestBody,
    signal: request.signal,
    ...(requestBody instanceof ReadableStream ? { duplex: "half" } : {}),
  };
  const upstreamRequest = new Request(upstreamUrl, requestInit);

  let response: Response;
  try {
    response = await fetchUpstream(upstreamRequest);
  } catch (error) {
    // The message only: the failed request carries the provider key.
    logEvent(
      "ai.proxy.upstream_failed",
      {
        provider,
        ...caller,
        route: upstreamPath,
        message: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    return jsonResponse({ error: "Upstream provider request failed" }, 502);
  }

  const logUsage = (usage: unknown) =>
    logEvent("ai.proxy.usage", {
      provider,
      ...caller,
      route: upstreamPath,
      model: prepared.model,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
      usage,
    });
  if (!response.body) {
    logUsage(null);
    return response;
  }
  return new Response(tapUsage(response.body, logUsage), response);
}

function operatorRoutes(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .filter((route) => AI_ROUTE_PATTERN.test(route));
}

function covers(route: string, path: string): boolean {
  return path === route || path.startsWith(`${route}/`);
}

/**
 * Inference, or a path both the app's manifest and the operator allow: an
 * app's own `ai.routes` never widens what the shared key can do by itself.
 */
function isAllowedRoute(
  provider: AiProvider,
  method: string,
  path: string,
  policy: AiPolicy | undefined,
  allowedByOperator: string[],
): boolean {
  if (method.toUpperCase() === "POST" && provider.inferenceRoutes.has(path)) {
    return true;
  }
  return (
    provider.extraRoutes &&
    (policy?.routes ?? []).some((route) => covers(route, path)) &&
    allowedByOperator.some((route) => covers(route, path))
  );
}

/**
 * Read what the gateway needs from the request body: the model (for the
 * allowlist and the log) and, for responses and chat completions, rewrite
 * `store` to false. Bodies the gateway does not need to see stream through.
 */
async function prepareBody(
  provider: AiProvider,
  request: Request,
  path: string,
  headers: Headers,
): Promise<PreparedBody> {
  if (!canIncludeBody(request.method) || !request.body) {
    return { ok: true, body: null, model: null };
  }
  if (!provider.inferenceRoutes.has(path)) {
    return { ok: true, body: request.body, model: null };
  }

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("multipart/form-data")) {
    // Audio and image uploads. Re-encoding gets a new boundary, so let fetch
    // set the content type.
    const form = await request.formData();
    headers.delete("content-type");
    headers.delete("content-length");
    const model = form.get("model");
    return {
      ok: true,
      body: form,
      model: typeof model === "string" ? model : null,
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      response: jsonResponse({ error: "Expected a JSON object body" }, 400),
    };
  }

  const body = payload as Record<string, unknown>;
  if (provider.unstoredRoutes.has(path)) {
    body.store = false;
  }
  headers.delete("content-length");
  return {
    ok: true,
    body: JSON.stringify(body),
    model: typeof body.model === "string" ? body.model : null,
  };
}

function buildUpstreamUrl(
  request: Request,
  provider: string,
  aiProvider: AiProvider,
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

  const upstreamUrl = new URL(aiProvider.upstreamBaseUrl);
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
  for (const header of [...headers.keys()]) {
    if (STRIPPED_PROXY_HEADER_PREFIXES.some((p) => header.startsWith(p))) {
      headers.delete(header);
    }
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
