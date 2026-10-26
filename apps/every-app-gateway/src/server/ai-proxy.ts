import {
  AI_DEFAULT_MODEL,
  AI_DEFAULT_PROVIDER,
  AI_DEFAULT_ROUTES,
  AI_GATEWAY_PROVIDER,
  CATALOG,
  GATEWAY_ERROR_HEADER,
  IDENTITY_HEADER,
  aiBaseUrl,
  aiGatewayConfigured,
  authorizationFor,
  joinProviderUrl,
  normalizeWorkersAiResponse,
  PUBLIC_HEADER,
  type AiDefaultResolution,
  type AiProviderCapability,
  type AiRoute,
  type Authorization,
  type CapabilityLookup,
  type CapabilitySecret,
} from "@every-app/sdk/internal";
import { logEvent } from "@every-app/perimeter";
import type { AiPolicy } from "@every-app/perimeter/manifest";
import { tapUsage, type AiUsage } from "./ai-usage";
import type { BodyEnd } from "./response-tap";

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
  // Anthropic's workspace selector: with a key spanning workspaces an app
  // would choose the workspace billed and watched.
  "anthropic-workspace-id",
  // Hugging Face's billing selector: the token's user may belong to several
  // billable organizations. (Headers.delete matches names case-insensitively.)
  "x-hf-bill-to",
];
// Every gateway trust header, and AI Gateway's (cf-aig-*), which would let
// an app pick a gateway's cache, logging or metadata.
const STRIPPED_PROXY_HEADER_PREFIXES = ["x-everyapp-", "cf-aig-"];

/**
 * An AI provider as the proxy reads it, from its catalog entry (an `ai`
 * capability in `@every-app/sdk/internal`, where the table lived before
 * the provider registry).
 */
interface AiProvider {
  /**
   * Where the provider's API lives. App paths are joined onto its path,
   * never replace it; null while a gateway setting the path needs is
   * unset.
   */
  upstreamBaseUrl: (env: AiProxyEnv) => string | null;
  /** The gateway secret holding the provider key. */
  keyEnv: string;
  /** The key on the request as the entry's `auth` puts it; null while unset. */
  authorization: (env: AiProxyEnv) => Authorization | null;
  /** Gateway settings the provider needs besides its key. */
  alsoNeeds: readonly string[];
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
  /** The dotted path in the answer that carries the call's price (`cost.responseField`: OpenRouter's `usage.cost`). */
  costField?: string;
  /** The routes the default route maps onto (`chat`, `embeddings`), where the entry has them. */
  chat?: AiRoute;
  embeddings?: AiRoute;
  /** How Cloudflare AI Gateway fronts the provider, when it does (the entry's `aig`). */
  aig?: { slug: string; trim?: string; header?: true };
  /** The entry fronts the others (AI Gateway itself): apps never call it by id. */
  proxy: boolean;
}

/** The proxy's view of an `ai` catalog entry. */
function aiProviderOf(capability: AiProviderCapability): AiProvider {
  return {
    upstreamBaseUrl: (env) => aiBaseUrl(capability, env),
    keyEnv: capability.auth.secret,
    authorization: (env) => authorizationFor(capability, env),
    alsoNeeds: capability.alsoNeeds ?? [],
    inferenceRoutes: new Set(capability.inferenceRoutes),
    unstoredRoutes: new Set(capability.unstoredRoutes ?? []),
    extraRoutes: capability.extraRoutes ?? false,
    ...(capability.normalize === "workers-ai"
      ? { normalizeResponse: normalizeWorkersAiResponse }
      : {}),
    ...(capability.cost?.responseField
      ? { costField: capability.cost.responseField }
      : {}),
    ...(capability.chat ? { chat: capability.chat } : {}),
    ...(capability.embeddings ? { embeddings: capability.embeddings } : {}),
    ...(capability.aig ? { aig: capability.aig } : {}),
    proxy: capability.kind === "proxy",
  };
}

/** The AI provider `id` names in `lookup`, or undefined (AI Gateway's own entry, `AI_GATEWAY_PROVIDER`, is one, marked `proxy`). */
function aiProviderFor(
  id: string,
  lookup: CapabilityLookup = CATALOG,
): AiProvider | undefined {
  const capability = lookup.get(id);
  return capability?.mode === "ai" ? aiProviderOf(capability) : undefined;
}

/**
 * The Gateway's settings by name: the providers' keys (and Workers AI's
 * account, `CLOUDFLARE_ACCOUNT_ID`), and `AI_PROXY_EXTRA_ROUTES`: OpenAI
 * paths beyond inference that apps may use, set by the operator (comma or
 * space separated, e.g. "/v1/files"). Each also covers its sub-paths. An
 * app still has to list a path in its manifest's `ai.routes`.
 */
type AiProxyEnv = Partial<Record<CapabilitySecret, string>> & {
  AI_PROXY_EXTRA_ROUTES?: string;
  /** Cloudflare AI Gateway in front of the providers: its id, and the token of an authenticated gateway. */
  AI_GATEWAY_ID?: string;
  AI_GATEWAY_API_KEY?: string;
};

/** The origin AI Gateway serves the providers from, and the header that names a gateway on Workers AI's own API. */
const AI_GATEWAY_ORIGIN = "https://gateway.ai.cloudflare.com";
const AI_GATEWAY_ID_HEADER = "cf-aig-gateway-id";
const AI_GATEWAY_AUTH_HEADER = "cf-aig-authorization";

// The same shape the manifest accepts for `ai.routes`.
const AI_ROUTE_PATTERN = /^\/v1(\/[a-z0-9_-]+)+$/;

interface HandleAuthenticatedAiProxyRequestOptions {
  request: Request;
  provider: string;
  env: AiProxyEnv;
  /** Where the provider id is found: the catalog alone, or the gateway's registry. */
  lookup?: CapabilityLookup;
  /** The calling app's manifest `ai` policy. */
  policy?: AiPolicy;
  /**
   * For `provider` "default": what the Gateway's default resolved to
   * (`resolveAiDefault`, on the organization's choice and the env). The
   * call goes to that provider's chat or embeddings route with its model
   * filled in where the app named none.
   */
  aiDefault?: AiDefaultResolution;
  /** Who is calling, for the usage log line. */
  caller?: { organizationId: string; appId: string };
  fetchUpstream?: (request: Request) => Promise<Response>;
  /**
   * Called once the moment the provider answered (its headers arrived),
   * before its body is forwarded: the call to count, whatever becomes of
   * the body. A browser or app that stops reading afterwards is not heard
   * in workerd (response-tap.ts), so this is the only report every call
   * gets. Never on a refusal.
   */
  onAnswer?: (report: AiAnswerReport) => void;
  /**
   * Called once with what `ai.proxy.usage` logs when the reading of the
   * body ends: the tokens its tail reported (null when it reported none).
   * Reaches the gateway when the body was read to the end, or when a
   * reader in this isolate cancelled it or the provider failed mid-body.
   */
  onUsage?: (report: AiUsageReport) => void;
}

interface AiAnswerReport {
  /** The provider the call went to: the resolved one for the default route. */
  provider: string;
  route: string;
  model: string | null;
  status: number;
}

interface AiUsageReport extends AiAnswerReport {
  usage: AiUsage | null;
  ended: BodyEnd;
}

type PreparedBody =
  | { ok: true; body: BodyInit | null; model: string | null }
  | { ok: false; response: Response };

/**
 * The provider's route a default-route path maps onto: the app sends
 * OpenAI's paths (`/v1/chat/completions`, `/v1/embeddings`) and the
 * resolved provider's entry says where each lives. Null for any other
 * path: the default serves chat and embeddings, nothing else.
 */
function defaultRouteFor(
  resolution: AiDefaultResolution,
  path: string,
): AiRoute | null {
  if (path === AI_DEFAULT_ROUTES.chat) return resolution.chat;
  if (path === AI_DEFAULT_ROUTES.embeddings)
    return resolution.embeddings ?? null;
  return null;
}

/**
 * Where the call goes with AI Gateway in front: the provider's slug under
 * the gateway's URL with the direct path's prefix dropped (OpenRouter's
 * `/api`, OpenAI's `/v1`), or, for a provider whose API is AI Gateway's
 * own host (Workers AI), the direct URL with the gateway named in a
 * header. Null when AI Gateway isn't configured, the entry has no slug,
 * or the path doesn't start with the prefix the slug drops (then the
 * call goes direct, as it always did).
 */
function throughAiGateway(
  provider: AiProvider,
  env: AiProxyEnv,
  directUrl: string,
  path: string,
  search: string,
): { url: string; headers: Record<string, string> } | null {
  if (!provider.aig || provider.proxy) return null;
  const isSet = (name: string) => {
    const value = (env as Record<string, unknown>)[name];
    return typeof value === "string" && value.trim().length > 0;
  };
  if (!aiGatewayConfigured(isSet)) return null;
  const gatewayId = env.AI_GATEWAY_ID!.trim();
  const headers: Record<string, string> = {};
  if (isSet("AI_GATEWAY_API_KEY")) {
    headers[AI_GATEWAY_AUTH_HEADER] =
      `Bearer ${env.AI_GATEWAY_API_KEY!.trim()}`;
  }
  if (provider.aig.header) {
    return {
      url: directUrl,
      headers: { ...headers, [AI_GATEWAY_ID_HEADER]: gatewayId },
    };
  }
  const trim = provider.aig.trim ?? "";
  if (trim && !(path === trim || path.startsWith(`${trim}/`))) return null;
  const base = `${AI_GATEWAY_ORIGIN}/v1/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!.trim())}/${encodeURIComponent(gatewayId)}/${provider.aig.slug}`;
  const url = joinProviderUrl(base, path.slice(trim.length) || "/", search);
  return url ? { url: url.toString(), headers } : null;
}

/**
 * Forward a request whose caller has already been authenticated by its
 * service-binding transport boundary.
 */
export async function handleAuthenticatedAiProxyRequest({
  request,
  provider,
  env,
  lookup = CATALOG,
  policy,
  aiDefault,
  caller,
  fetchUpstream = fetch,
  onAnswer,
  onUsage,
}: HandleAuthenticatedAiProxyRequestOptions): Promise<Response> {
  const isDefault = provider === AI_DEFAULT_PROVIDER;
  if (isDefault && !aiDefault) {
    return aiRefusal(
      "ai_default_not_configured",
      503,
      "The Gateway's default model provider isn't set up: its operator sets one key with everyapp ai default <provider> (or any provider's key, in the order everyapp ai show lists).",
    );
  }
  // The default route goes to the resolved provider; its entry decides
  // the rest exactly as if the app had named it.
  const resolved = isDefault ? aiDefault!.provider : provider;
  const aiProvider = aiProviderFor(resolved, lookup);
  if (!aiProvider || aiProvider.proxy) {
    return aiRefusal(
      "ai_provider_not_supported",
      404,
      aiProvider?.proxy
        ? `Provider not supported: ${resolved} fronts the model providers and serves no models of its own; list a model provider, and the Gateway sends through AI Gateway once its operator turns it on (everyapp ai gateway on).`
        : `Provider not supported: the gateway has no AI provider "${resolved}".`,
    );
  }
  if (isDefault && !aiDefault!.configured) {
    const settings = aiDefault!.settings;
    return aiRefusal(
      "ai_default_not_configured",
      503,
      `The Gateway's default model provider (${aiDefault!.label}) isn't configured: the gateway needs ${settings.join(" and ")}. Its operator sets ${settings.length === 1 ? "it" : "them"} with: everyapp secret set ${settings.join(" ")} (or picks another provider with everyapp ai default <provider>)`,
    );
  }

  const authorization = aiProvider.authorization(env);
  const baseUrl = aiProvider.upstreamBaseUrl(env);
  if (!authorization || !baseUrl) {
    const settings = [aiProvider.keyEnv, ...aiProvider.alsoNeeds];
    return aiRefusal(
      "ai_provider_not_configured",
      503,
      `Provider is not configured: the gateway needs ${settings.join(" and ")} for ${resolved}. Its operator sets ${settings.length === 1 ? "it" : "them"} with: everyapp secret set ${settings.join(" ")}`,
    );
  }

  // The app's path under /api/ai/<provider>; for the default route, the
  // resolved provider's own route for it.
  const requested = requestedPath(request, provider);
  if (!requested) {
    return aiRefusal("ai_request_invalid", 400, "Invalid proxy request path");
  }
  let upstreamPath = requested.path;
  let fillModel: string | null = null;
  if (isDefault) {
    const route = defaultRouteFor(aiDefault!, requested.path);
    if (!route) {
      return aiRefusal(
        "ai_route_not_allowed",
        403,
        `The default route serves ${AI_DEFAULT_ROUTES.chat}${aiDefault!.embeddings ? ` and ${AI_DEFAULT_ROUTES.embeddings}` : ""} only; for anything else list the provider under providers and call /api/ai/<provider>/…`,
      );
    }
    upstreamPath = route.path;
    fillModel =
      requested.path === AI_DEFAULT_ROUTES.chat
        ? aiDefault!.model
        : route.model;
  }
  const direct = joinProviderUrl(baseUrl, upstreamPath, requested.search);
  if (!direct) {
    return aiRefusal("ai_request_invalid", 400, "Invalid proxy request path");
  }
  let upstreamUrl = direct.toString();
  // With AI Gateway in front, the same call under the gateway's URL (or
  // with the gateway named in a header), the provider's own key still on.
  const fronted = throughAiGateway(
    aiProvider,
    env,
    upstreamUrl,
    upstreamPath,
    requested.search,
  );
  if (fronted) upstreamUrl = fronted.url;
  if (Object.keys(authorization.query).length > 0) {
    const target = new URL(upstreamUrl);
    for (const [name, value] of Object.entries(authorization.query)) {
      target.searchParams.set(name, value);
    }
    upstreamUrl = target.toString();
  }

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
  for (const [name, value] of Object.entries(authorization.headers)) {
    requestHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(fronted?.headers ?? {})) {
    requestHeaders.set(name, value);
  }

  const prepared = await prepareBody(
    aiProvider,
    request,
    upstreamPath,
    requestHeaders,
    fillModel,
  );
  if (!prepared.ok) return prepared.response;

  // The model allowlist covers inference, where the gateway reads the model.
  // Endpoints an app opted into with `ai.routes` stream through unread. On
  // the default route the operator chose the model, so the list doesn't apply.
  if (
    !isDefault &&
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
        provider: resolved,
        ...(isDefault ? { via: AI_DEFAULT_PROVIDER } : {}),
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

  // The provider answered, and bills from here: the call is counted now,
  // before the body goes out, so a stream nobody reads to the end (a
  // closed tab, an app that gave up) still counts.
  const answer = {
    provider: resolved,
    route: upstreamPath,
    model: prepared.model,
    status: response.status,
  };
  onAnswer?.(answer);
  // When the reading ends, the tokens the tail reported. `ended` says when
  // the body was not read to the end (only a reader in this isolate or a
  // provider failure can say so; a disconnected browser is never heard).
  const logUsage = (usage: AiUsageReport["usage"], ended: BodyEnd = "done") => {
    logEvent("ai.proxy.usage", {
      ...caller,
      ...answer,
      ...(isDefault ? { via: AI_DEFAULT_PROVIDER } : {}),
      ...(fronted ? { aiGateway: true } : {}),
      requestId: response.headers.get("x-request-id"),
      usage,
      ...(ended === "done" ? {} : { ended }),
    });
    onUsage?.({ ...answer, usage, ended });
  };
  if (!response.body) {
    logUsage(null);
    return response;
  }
  return new Response(
    tapUsage(response.body, logUsage, aiProvider.costField),
    response,
  );
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
  /** The default route's model, put in where the app named none or named `default`. */
  fillModel: string | null = null,
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
    // The whole form goes upstream, so a second model part would reach the
    // provider too, and which one its parser honours is its choice, not the
    // allowlist's. One part or none.
    const models = form.getAll("model");
    if (models.length > 1) {
      return {
        ok: false,
        response: aiRefusal(
          "ai_request_invalid",
          400,
          "Expected at most one model part in the form body",
        ),
      };
    }
    let model = typeof models[0] === "string" ? models[0] : null;
    if (fillModel !== null && (model === null || model === AI_DEFAULT_MODEL)) {
      form.set("model", fillModel);
      model = fillModel;
    }
    return { ok: true, body: form, model };
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
  if (
    fillModel !== null &&
    (body.model === undefined ||
      body.model === null ||
      body.model === AI_DEFAULT_MODEL)
  ) {
    body.model = fillModel;
  }
  headers.delete("content-length");
  return {
    ok: true,
    body: JSON.stringify(body),
    model: typeof body.model === "string" ? body.model : null,
  };
}

/**
 * The app's path and query under `/api/ai/<provider>`: what the route
 * checks read, and what is joined onto the provider's base (whose own
 * path, like Workers AI's account path, is kept). Null for a path that
 * could leave the provider's base.
 */
function requestedPath(
  request: Request,
  provider: string,
): { path: string; search: string } | null {
  const incomingUrl = new URL(request.url);
  const routePrefix = `/api/ai/${provider}`;
  if (!matchesProviderRoute(incomingUrl.pathname, routePrefix)) {
    return null;
  }
  const path = incomingUrl.pathname.slice(routePrefix.length) || "/";
  if (!isSafeUpstreamPath(path)) return null;
  return { path, search: incomingUrl.search };
}

function matchesProviderRoute(pathname: string, routePrefix: string): boolean {
  return pathname === routePrefix || pathname.startsWith(`${routePrefix}/`);
}

/**
 * The route checks read the path as the URL parser left it: dot segments and
 * doubled slashes resolved, percent-encoding kept. A provider decodes before
 * it routes, so `/v1/files/x/..%2F..%2Fbatches` would pass a `/v1/files`
 * opt-in here and land on `/v1/batches` there, with the operator's key. An
 * encoded slash, backslash, dot or percent sign has no honest use in these
 * paths, so the gateway refuses it before any route check.
 */
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c|2e|25)/i;

function isSafeUpstreamPath(pathname: string): boolean {
  if (!pathname.startsWith("/")) {
    return false;
  }

  if (pathname.startsWith("//")) {
    return false;
  }

  if (ENCODED_PATH_SEPARATOR.test(pathname)) {
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
 * `ai_default_not_configured`, `ai_request_invalid`, `ai_route_not_allowed`,
 * `model_not_allowed`, `ai_upstream_failed`, and the AppGateway
 * entrypoint's own on AI routes):
 * `x-everyapp-error` names it (gatewayRefusal reads it), and the body is
 * OpenAI's error shape, so OpenAI SDKs and ai-sdk clients show the message.
 * `code` and `message` are at the top level too, as the gateway's other
 * refusals have them.
 */
export function aiRefusal(
  code: string,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error: { message, code, type: "gateway_refusal" }, code, message },
    { status, headers: { ...headers, [GATEWAY_ERROR_HEADER]: code } },
  );
}
