import {
  AI_DEFAULT_MODEL,
  AI_DEFAULT_PROVIDER,
  AI_DEFAULT_ROUTES,
  aiProviderSettings,
  authorizationOf,
  ConfigurationError,
  DEV_AI_PROVIDERS,
  devAiProvider,
  joinProviderUrl,
  resolveAiDefault,
  type DevAiProviderSpec,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  type GatewayCallFor,
} from "./attribution.js";

export const BINDING_ORIGIN = "http://every-app-gateway.internal";
const AI_PROXY_PREFIX = "/api/ai/";

export interface GatewayServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/** The env names createGatewayFetch reads. */
interface GatewayFetchEnv {
  EVERY_APP_GATEWAY?: GatewayServiceBinding;
  EVERYAPP_DEV?: string | boolean;
  /** `1` on a shared app's Workers (`everyAppWorker()` sets it). */
  EVERYAPP_SHARED?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  /** Workers AI: an API token (Workers AI Read and Edit) and the account it bills. */
  WORKERS_AI_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
}

export interface CreateGatewayFetchOptions {
  /**
   * The Worker env, as it is: the EVERY_APP_GATEWAY binding when deployed,
   * or in local dev EVERYAPP_DEV and the provider's settings in
   * `.dev.vars` (`OPENROUTER_API_KEY`, …). No cast needed.
   */
  env: object;
  /**
   * Whom the call is for. Left out, the request `everyApp()` is serving
   * (its user, while the identity is good) or the organization
   * `withOrganization()` named; outside both, `RequestContextError`.
   * Explicitly: the inbound request, or `{ background: true,
   * organizationId }` for work no person started (crons, Workflows,
   * queues). A shared app's Worker must end up with one or the other
   * ({@link AttributionError}).
   */
  for?: GatewayCallFor;
  /**
   * `true`: answer null instead of throwing `ConfigurationError` when AI
   * is unavailable (no binding, and in local dev no provider key), so a
   * feature that can do without a model checks for null. A binding that
   * isn't one, and an attribution mistake, still throw.
   */
  optional?: boolean;
}

/**
 * Create a fetch for the gateway's AI providers (`/api/ai/<provider>/…`),
 * backed by the private gateway service binding. In local dev only, the
 * developer's own provider key from `.dev.vars` is a direct-provider
 * fallback when no binding exists.
 */
export function createGatewayFetch(
  options: CreateGatewayFetchOptions & { optional: true },
): typeof fetch | null;
export function createGatewayFetch(
  options: CreateGatewayFetchOptions,
): typeof fetch;
export function createGatewayFetch({
  env: workerEnv,
  for: explicitTarget,
  optional = false,
}: CreateGatewayFetchOptions): typeof fetch | null {
  const env = workerEnv as GatewayFetchEnv;
  // Checked now, so a call nobody's fails where the fetch is made; and
  // again per call, where an identity may since have neared its expiry.
  attributionFor(env, explicitTarget, "createGatewayFetch");
  const binding = env.EVERY_APP_GATEWAY;
  const devProviders = env.EVERYAPP_DEV ? localProviders(env) : {};

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!binding && Object.keys(devProviders).length === 0) {
    if (optional) return null;
    throw new ConfigurationError(
      `AI gateway unavailable: deploy with the EVERY_APP_GATEWAY binding, or set the provider's key (${listOf(
        Object.values(DEV_AI_PROVIDERS).map((spec) =>
          settingsNames(spec, "with"),
        ),
        "or",
      )}) in .dev.vars for direct local development.`,
    );
  }

  return async (input, init) => {
    const target = attributionFor(env, explicitTarget, "createGatewayFetch");
    const outbound = new Request(input, init);
    const headers = new Headers(outbound.headers);
    headers.delete("authorization");

    if (binding) {
      applyAttribution(headers, target);
      const url = new URL(outbound.url);
      const bindingRequest = streamingRequest(
        `${BINDING_ORIGIN}${url.pathname}${url.search}`,
        outbound,
        headers,
      );
      return binding.fetch(bindingRequest);
    }

    const direct = directProviderPath(outbound.url, env);
    const { provider, spec, path, search } = direct;
    const dev = devProviders[provider];
    if (!dev) {
      throw new ConfigurationError(
        `Set ${settingsNames(spec)} in .dev.vars to call ${provider} in local development.`,
      );
    }
    const url = joinProviderUrl(`${spec.origin}${dev.basePath}`, path, search);
    if (!url) throw new ConfigurationError("Invalid provider proxy path.");
    applyAttribution(headers, undefined);
    // The default route in dev: the model filled in as the gateway would.
    let body: Request = outbound;
    if (direct.fillModel !== null) {
      body = await withModel(outbound, direct.fillModel, headers);
    }
    // The developer's key, put where the provider's entry says (a bearer
    // token for the three today), as the gateway would put its own.
    const auth = authorizationOf(spec.auth, { [spec.keyEnv]: dev.key });
    for (const [name, value] of Object.entries(auth?.headers ?? {})) {
      headers.set(name, value);
    }
    for (const [name, value] of Object.entries(auth?.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const response = await fetch(
      streamingRequest(url.toString(), body, headers),
    );
    // What the gateway does to the provider's answer, so dev behaves alike.
    return spec.normalizeResponse?.(path, response) ?? response;
  };
}

/**
 * `source` with `model` put into its JSON body where the app named none
 * or named `default`, as the gateway's default route does. A body that
 * isn't a JSON object goes through as it is.
 */
async function withModel(
  source: Request,
  model: string,
  headers: Headers,
): Promise<Request> {
  if (!canIncludeBody(source.method) || !source.body) return source;
  const text = await source.clone().text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return source;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return source;
  }
  const record = payload as Record<string, unknown>;
  if (
    record["model"] === undefined ||
    record["model"] === null ||
    record["model"] === AI_DEFAULT_MODEL
  ) {
    record["model"] = model;
  }
  headers.delete("content-length");
  return new Request(source.url, {
    method: source.method,
    headers,
    body: JSON.stringify(record),
    signal: source.signal,
  });
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

interface LocalProvider {
  key: string;
  /** Joined onto the provider's origin before every path. */
  basePath: string;
}

/** The providers `.dev.vars` sets every setting of, with their key and base path. */
function localProviders(env: GatewayFetchEnv): Record<string, LocalProvider> {
  const providers: Record<string, LocalProvider> = {};
  for (const [provider, spec] of Object.entries(DEV_AI_PROVIDERS)) {
    const settings: Record<string, string> = {};
    for (const name of aiProviderSettings(spec)) {
      const value = (env as Record<string, unknown>)[name];
      if (typeof value === "string" && value.trim()) {
        settings[name] = value.trim();
      }
    }
    const key = settings[spec.keyEnv];
    // A provider is reachable only with every setting it needs.
    if (!key || Object.keys(settings).length < aiProviderSettings(spec).length)
      continue;
    providers[provider] = { key, basePath: spec.basePath?.(settings) ?? "" };
  }
  return providers;
}

function directProviderPath(
  input: string,
  env: GatewayFetchEnv,
): {
  provider: string;
  spec: DevAiProviderSpec;
  path: string;
  search: string;
  /** The default route's model to fill in; null on a provider's own route. */
  fillModel: string | null;
} {
  const incoming = new URL(input);
  const match = incoming.pathname.match(
    /^\/api\/ai\/([a-z][a-z0-9-]*)(\/.*)?$/,
  );
  let provider = match?.[1];
  let path = match?.[2] || "/";
  let fillModel: string | null = null;
  if (provider === AI_DEFAULT_PROVIDER) {
    // The default in dev, by the gateway's rule on the developer's own
    // `.dev.vars`: the first provider of the order with every setting set.
    const values = env as Record<string, unknown>;
    const resolution = resolveAiDefault({
      choice: null,
      isSet: (name) =>
        typeof values[name] === "string" &&
        (values[name] as string).trim().length > 0,
    });
    if (!resolution.configured) {
      throw new ConfigurationError(
        `Set ${resolution.settings.join(" and ")} (or another model provider's key) in .dev.vars to call the default model in local development.`,
      );
    }
    const route =
      path === AI_DEFAULT_ROUTES.chat
        ? resolution.chat
        : path === AI_DEFAULT_ROUTES.embeddings
          ? resolution.embeddings
          : undefined;
    if (!route) {
      throw new ConfigurationError(
        `The default model serves ${AI_DEFAULT_ROUTES.chat} and ${AI_DEFAULT_ROUTES.embeddings} only; call /api/ai/<provider>/… for anything else.`,
      );
    }
    provider = resolution.provider;
    path = route.path;
    fillModel = path === resolution.chat.path ? resolution.model : route.model;
  }
  const spec = provider ? devAiProvider(provider) : undefined;
  if (!provider || !spec) {
    throw new ConfigurationError(
      `Direct local provider fallback only supports ${listOf(
        [AI_DEFAULT_PROVIDER, ...Object.keys(DEV_AI_PROVIDERS)].map(
          (name) => `${AI_PROXY_PREFIX}${name}`,
        ),
        "and",
      )} paths.`,
    );
  }

  if (path.startsWith("//") || path.includes("\\")) {
    throw new ConfigurationError("Invalid provider proxy path.");
  }
  return { provider, spec, path, search: incoming.search, fillModel };
}

/** A provider's settings as a person reads them: `KEY`, or `KEY and SETTING`. */
function settingsNames(
  spec: DevAiProviderSpec,
  conjunction: "and" | "with" = "and",
): string {
  const [key, ...others] = aiProviderSettings(spec);
  return others.length
    ? `${key} ${conjunction} ${listOf(others, "and")}`
    : key!;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(items: readonly string[], conjunction: "and" | "or"): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

function canIncludeBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}
