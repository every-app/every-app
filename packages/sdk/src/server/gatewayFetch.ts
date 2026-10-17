import {
  aiProviderSettings,
  ConfigurationError,
  DEV_AI_PROVIDERS,
  devAiProvider,
  joinProviderUrl,
  type DevAiProviderSpec,
} from "../internal/index.js";
import {
  applyAttribution,
  checkAttribution,
  type GatewayCallFor,
} from "./attribution.js";

export const BINDING_ORIGIN = "http://every-app-gateway.internal";
const AI_PROXY_PREFIX = "/api/ai/";

export interface GatewayServiceBinding {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface GatewayFetchEnv {
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
  env: GatewayFetchEnv;
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
 * Create a fetch for the gateway's AI providers (`/api/ai/<provider>/…`),
 * backed by the private gateway service binding. In local dev only, the
 * developer's own provider key from `.dev.vars` is a direct-provider
 * fallback when no binding exists.
 */
export function createGatewayFetch({
  env,
  for: target,
}: CreateGatewayFetchOptions): typeof fetch {
  checkAttribution(env, target, "createGatewayFetch");
  const binding = env.EVERY_APP_GATEWAY;
  const devProviders = env.EVERYAPP_DEV ? localProviders(env) : {};

  if (binding && typeof binding.fetch !== "function") {
    throw new ConfigurationError(
      "EVERY_APP_GATEWAY is configured but is not a valid service binding.",
    );
  }
  if (!binding && Object.keys(devProviders).length === 0) {
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

    const { provider, spec, path, search } = directProviderPath(outbound.url);
    const dev = devProviders[provider];
    if (!dev) {
      throw new ConfigurationError(
        `Set ${settingsNames(spec)} in .dev.vars to call ${provider} in local development.`,
      );
    }
    const url = joinProviderUrl(`${spec.origin}${dev.basePath}`, path, search);
    if (!url) throw new ConfigurationError("Invalid provider proxy path.");
    applyAttribution(headers, undefined);
    headers.set("authorization", `Bearer ${dev.key}`);
    const response = await fetch(
      streamingRequest(url.toString(), outbound, headers),
    );
    // What the gateway does to the provider's answer, so dev behaves alike.
    return spec.normalizeResponse?.(path, response) ?? response;
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

function directProviderPath(input: string): {
  provider: string;
  spec: DevAiProviderSpec;
  path: string;
  search: string;
} {
  const incoming = new URL(input);
  const match = incoming.pathname.match(
    /^\/api\/ai\/([a-z][a-z0-9-]*)(\/.*)?$/,
  );
  const provider = match?.[1];
  const spec = provider ? devAiProvider(provider) : undefined;
  if (!provider || !spec) {
    throw new ConfigurationError(
      `Direct local provider fallback only supports ${listOf(
        Object.keys(DEV_AI_PROVIDERS).map(
          (name) => `${AI_PROXY_PREFIX}${name}`,
        ),
        "and",
      )} paths.`,
    );
  }

  const path = match?.[2] || "/";
  if (path.startsWith("//") || path.includes("\\")) {
    throw new ConfigurationError("Invalid provider proxy path.");
  }
  return { provider, spec, path, search: incoming.search };
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
