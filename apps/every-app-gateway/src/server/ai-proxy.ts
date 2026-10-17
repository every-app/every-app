import {
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  joinProviderUrl,
  normalizeWorkersAiResponse,
  PUBLIC_HEADER,
  workersAiBasePath,
} from "@every-app/sdk/internal";
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
  /**
   * Where the provider's API lives. App paths are joined onto its path,
   * never replace it. A function when it depends on a gateway setting
   * (null while that is unset).
   */
  upstreamBaseUrl: string | ((env: AiProxyEnv) => string | null);
  /** The gateway secret holding the provider key. */
  keyEnv: "OPENAI_API_KEY" | "OPENROUTER_API_KEY" | "WORKERS_AI_API_TOKEN";
  /** Gateway settings the provider needs besides its key. */
  alsoNeeds?: readonly (keyof AiProxyEnv)[];
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
  /** Turns the provider's answer at a path into what OpenAI clients parse. */
  normalizeResponse?: (path: string, response: Response) => Response;
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
  // Workers AI's OpenAI-compatible REST API, in the gateway's own account
  // (`/v1/run/...` and the native `/run/<model>` stay closed). Its chat
  // streams send all-digit tokens as JSON numbers, which the gateway turns
  // back into strings (normalizeWorkersAiResponse).
  "workers-ai": {
    upstreamBaseUrl: (env) =>
      env.CLOUDFLARE_ACCOUNT_ID?.trim()
        ? `https://api.cloudflare.com${workersAiBasePath(env.CLOUDFLARE_ACCOUNT_ID)}`
        : null,
    keyEnv: "WORKERS_AI_API_TOKEN",
    alsoNeeds: ["CLOUDFLARE_ACCOUNT_ID"],
    inferenceRoutes: new Set([
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/responses",
    ]),
    unstoredRoutes: new Set(),
    extraRoutes: false,
    normalizeResponse: normalizeWorkersAiResponse,
  },
};

interface AiProxyEnv {
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** A Cloudflare API token with Workers AI Read and Edit, for `workers-ai`. */
  WORKERS_AI_API_TOKEN?: string;
  /** The account Workers AI runs (and bills) in: the gateway's own. */
  CLOUDFLARE_ACCOUNT_ID?: string;
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
    return aiRefusal(
      "ai_provider_not_supported",
      404,
      `Provider not supported: the gateway has no AI provider "${provider}".`,
    );
  }

  const providerKey = env[aiProvider.keyEnv]?.trim();
  const baseUrl =
    typeof aiProvider.upstreamBaseUrl === "function"
      ? aiProvider.upstreamBaseUrl(env)
      : aiProvider.upstreamBaseUrl;
  if (!providerKey || !baseUrl) {
    const settings = [aiProvider.keyEnv, ...(aiProvider.alsoNeeds ?? [])];
    return aiRefusal(
      "ai_provider_not_configured",
      503,
      `Provider is not configured: the gateway needs ${settings.join(" and ")} for ${provider}.`,
    );
  }

  const upstream = buildUpstreamUrl(request, provider, baseUrl);
  if (!upstream) {
    return aiRefusal("ai_request_invalid", 400, "Invalid proxy request path");
  }
  const { url: upstreamUrl, path: upstreamPath } = upstream;

  if (
    !isAllowedRoute(
      aiProvider,
      request.method,
      upstreamPath,
      policy,
      operatorRoutes(env.AI_PROXY_EXTRA_ROUTES),
    )
  ) {
    return aiRefusal(
      "ai_route_not_allowed",
      403,
      "This provider endpoint is not available to apps",
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
    return aiRefusal(
      "model_not_allowed",
      403,
      prepared.model
        ? `The app manifest does not allow this model (${prepared.model}); list it in ai.models.`
        : "The app manifest does not allow this model: the request names none.",
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
    return aiRefusal(
      "ai_upstream_failed",
      502,
      "Upstream provider request failed",
    );
  }
  response = aiProvider.normalizeResponse?.(upstreamPath, response) ?? response;

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
      response: aiRefusal(
        "ai_request_invalid",
        400,
        "Expected a JSON object body",
      ),
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

/**
 * The provider URL for an app's `/api/ai/<provider>/<path>`: `<path>` joined
 * onto the provider's base (whose own path, like Workers AI's account path,
 * is kept), and `<path>` itself, which the route checks read.
 */
function buildUpstreamUrl(
  request: Request,
  provider: string,
  baseUrl: string,
): { url: string; path: string } | null {
  const incomingUrl = new URL(request.url);
  const routePrefix = `/api/ai/${provider}`;

  if (!matchesProviderRoute(incomingUrl.pathname, routePrefix)) {
    return null;
  }

  const upstreamPath = incomingUrl.pathname.slice(routePrefix.length) || "/";
  if (!isSafeUpstreamPath(upstreamPath)) {
    return null;
  }

  const upstreamUrl = joinProviderUrl(
    baseUrl,
    upstreamPath,
    incomingUrl.search,
  );
  return upstreamUrl
    ? { url: upstreamUrl.toString(), path: upstreamPath }
    : null;
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

/**
 * A refusal the AI proxy makes itself, as opposed to the provider's answer
 * (`ai_provider_not_supported`, `ai_provider_not_configured`,
 * `ai_request_invalid`, `ai_route_not_allowed`, `model_not_allowed`,
 * `ai_upstream_failed`, and the AppGateway entrypoint's own on AI routes):
 * `x-everyapp-error` names it (gatewayRefusal reads it), and the body is
 * OpenAI's error shape, so OpenAI SDKs and ai-sdk clients show the message.
 * `code` and `message` are at the top level too, as the gateway's other
 * refusals have them.
 */
export function aiRefusal(
  code: string,
  status: number,
  message: string,
): Response {
  return Response.json(
    { error: { message, code, type: "gateway_refusal" }, code, message },
    { status, headers: { [GATEWAY_ERROR_HEADER]: code } },
  );
}
