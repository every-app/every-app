/**
 * `ai()`: the Gateway's default chat model for an app that needs "a model"
 * rather than one provider (docs/design/2026-10-model-providers.md). The
 * manifest says `ai: { chat: true }` (or `{ chat: { why } }`); the Gateway's
 * operator decides which provider and model that is (`everyapp ai
 * default`, else OpenRouter → Workers AI → OpenAI → …, the first with its
 * key set), and the app never names either: it sends OpenAI-shaped chat
 * completions (and embeddings) to `/api/ai/default/v1/…` with `model:
 * "default"` or no model at all, and the Gateway fills the model in.
 *
 * An OpenAI client takes `baseURL` and `fetch` as they are:
 *
 *   const { baseURL, fetch, model } = ai({ env, for: request });
 *   const client = new OpenAI({ baseURL, fetch, apiKey: "gateway-managed" });
 *   await client.chat.completions.create({ model, messages });
 *
 * In local development with no Gateway, the developer's own key in
 * `.dev.vars` decides the provider by the same order (createGatewayFetch's
 * fallback). An app that needs one provider in particular keeps listing it
 * under `providers` and calling `/api/ai/<provider>/…`.
 */
import {
  AI_DEFAULT_MODEL,
  AI_DEFAULT_PROVIDER,
  CATALOG,
  ConfigurationError,
  aiProviderSettings,
  devAiProvider,
  resolveAiDefault,
} from "../internal/index.js";
import {
  applyAttribution,
  attributionFor,
  type GatewayCallFor,
} from "./attribution.js";
import {
  BINDING_ORIGIN,
  createGatewayFetch,
  type CreateGatewayFetchOptions,
  type GatewayServiceBinding,
} from "./gatewayFetch.js";
import type { SetupInfo } from "./refusal.js";

export interface AiClient {
  /** `http://every-app-gateway.internal/api/ai/default/v1`: an OpenAI client's base URL. */
  baseURL: string;
  /** The fetch that reaches the Gateway (or, in dev, the provider directly). */
  fetch: typeof fetch;
  /** The model name that means "whatever the Gateway's default is": `default`. */
  model: typeof AI_DEFAULT_MODEL;
  /** The default route's chat completions URL, for a plain `fetch`. */
  chatCompletionsUrl: string;
  /** The default route's embeddings URL, for a plain `fetch`. */
  embeddingsUrl: string;
}

/** The base URL of the default route, as the SDK and the docs name it. */
export const AI_DEFAULT_BASE_URL = `${BINDING_ORIGIN}/api/ai/${AI_DEFAULT_PROVIDER}/v1`;

/**
 * The Gateway's default chat model as a client: a base URL, a fetch and
 * the model name to send. Throws `ConfigurationError` where
 * `createGatewayFetch` does (no binding and no dev key) and
 * `AttributionError` where a shared app's call says nobody's.
 */
export function ai(
  options: CreateGatewayFetchOptions & { optional: true },
): AiClient | null;
export function ai(options: CreateGatewayFetchOptions): AiClient;
export function ai(options: CreateGatewayFetchOptions): AiClient | null {
  const fetch = createGatewayFetch(options);
  if (!fetch) return null;
  return {
    baseURL: AI_DEFAULT_BASE_URL,
    fetch,
    model: AI_DEFAULT_MODEL,
    chatCompletionsUrl: `${AI_DEFAULT_BASE_URL}/chat/completions`,
    embeddingsUrl: `${AI_DEFAULT_BASE_URL}/embeddings`,
  };
}

/** Whether model calls to a provider (or the default) would go through. */
export interface AiStatus extends SetupInfo {
  /** The id asked about: `default`, or a provider's (`openrouter`, `workers-ai`, …). */
  provider: string;
  /** The manifest asks for it: `ai.chat` for `default`, else `providers`. */
  requested: boolean;
  /** The Gateway (in local dev, `.dev.vars`) holds every setting it needs. */
  configured: boolean;
  /** Calls would go through. */
  ready: boolean;
  /**
   * For `default`: the provider and model calls go to now, or null while
   * none is configured. Null for a named provider.
   */
  resolved: { provider: string; label: string; model: string } | null;
}

/**
 * Whether the app can use a model right now, without calling one: gate
 * an AI feature and show `setup` ("A chat model isn't set up on this
 * Gateway: it needs OPENROUTER_API_KEY. An admin runs: pnpm everyapp
 * configure inbox") up front instead of failing mid-task. `provider`
 * defaults to `default`, the Gateway's default model (`ai: { chat: true }`);
 * name one the manifest lists under `providers` to ask about it instead.
 * The Gateway owns the wording: show `setup` and `command` as they are.
 *
 * Over the binding it sends `GET /api/ai/<provider>`; in local dev it
 * answers from `.dev.vars` by the same rule `createGatewayFetch()` uses.
 */
export async function aiStatus({
  env,
  provider = AI_DEFAULT_PROVIDER,
  for: explicitTarget,
}: {
  env: object;
  provider?: string;
  /**
   * Whom the status is for: the default resolves on that organization's
   * choice (`everyapp ai default`). Left out, the request `everyApp()` is
   * serving or the organization `withOrganization()` named, as on every
   * call.
   */
  for?: GatewayCallFor;
}): Promise<AiStatus> {
  const target = attributionFor(env, explicitTarget, "aiStatus");
  const values = env as Record<string, unknown>;
  const binding = values["EVERY_APP_GATEWAY"] as
    | GatewayServiceBinding
    | undefined;
  const unavailable: AiStatus = {
    provider,
    requested: false,
    configured: false,
    ready: false,
    resolved: null,
    settings: [],
    setup: null,
    command: null,
  };
  if (binding && typeof binding.fetch === "function") {
    const headers = new Headers();
    if (target !== undefined) applyAttribution(headers, target);
    const response = await binding.fetch(
      `${BINDING_ORIGIN}/api/ai/${encodeURIComponent(provider)}`,
      { headers },
    );
    if (!response.ok) return unavailable;
    const body = (await response.json()) as Partial<AiStatus>;
    return {
      ...unavailable,
      ...body,
      provider,
      settings: Array.isArray(body.settings) ? body.settings : [],
      setup: typeof body.setup === "string" ? body.setup : null,
      command: typeof body.command === "string" ? body.command : null,
      resolved: body.resolved ?? null,
    };
  }
  if (!values["EVERYAPP_DEV"]) return unavailable;
  const isSet = (name: string) =>
    typeof values[name] === "string" && (values[name] as string).trim() !== "";
  const dev = (
    label: string,
    settings: readonly string[],
    configured: boolean,
    resolved: AiStatus["resolved"],
    also = "",
  ): AiStatus => ({
    provider,
    requested: true,
    configured,
    ready: configured,
    resolved,
    settings: configured ? [] : [...settings],
    setup: configured
      ? null
      : `${label} isn't set up for local development: set ${settings.join(" and ")}${also} in .dev.vars.`,
    command: null,
  });
  if (provider === AI_DEFAULT_PROVIDER) {
    const resolution = resolveAiDefault({ choice: null, isSet });
    return dev(
      "A chat model",
      resolution.settings,
      resolution.configured,
      resolution.configured
        ? {
            provider: resolution.provider,
            label: resolution.label,
            model: resolution.model,
          }
        : null,
      " (or another model provider's key)",
    );
  }
  const spec = devAiProvider(provider);
  if (!spec) return unavailable;
  const settings = aiProviderSettings(spec);
  return dev(
    CATALOG.get(provider)?.label ?? provider,
    settings,
    settings.every(isSet),
    null,
  );
}

const CHAT_COMPLETIONS = "/chat/completions";

/**
 * A provider's root behind the Gateway, `http://every-app-gateway.internal/api/ai/<provider>`:
 * join the provider's own paths onto it (`/api/v1/chat/completions` for
 * OpenRouter) and send them with `createGatewayFetch()`. For an OpenAI
 * client's `baseURL`, use {@link aiBaseUrl}.
 */
export function providerBaseUrl(provider: string): string {
  return `${BINDING_ORIGIN}/api/ai/${encodeURIComponent(provider)}`;
}

/**
 * The OpenAI-compatible base URL of `provider` behind the Gateway, for an
 * OpenAI client's `baseURL` (with `fetch: createGatewayFetch(...)`):
 * `default` (the default) is {@link AI_DEFAULT_BASE_URL},
 * `…/api/ai/default/v1`; a catalog provider's is its root and the prefix
 * of its chat route (`…/api/ai/openrouter/api/v1`, `…/api/ai/workers-ai/v1`,
 * `…/api/ai/openai/v1`). Throws `ConfigurationError` for a provider with
 * no OpenAI-compatible chat route (Cohere): call {@link providerBaseUrl}
 * with its own paths instead.
 */
export function aiBaseUrl(provider: string = AI_DEFAULT_PROVIDER): string {
  if (provider === AI_DEFAULT_PROVIDER) return AI_DEFAULT_BASE_URL;
  const capability = CATALOG.get(provider);
  const chat =
    capability?.mode === "ai" && "chat" in capability
      ? capability.chat
      : undefined;
  if (!chat?.path.endsWith(CHAT_COMPLETIONS)) {
    throw new ConfigurationError(
      `${provider} has no OpenAI-compatible chat route in the catalog: join its own paths onto providerBaseUrl("${provider}") instead.`,
    );
  }
  return `${providerBaseUrl(provider)}${chat.path.slice(0, -CHAT_COMPLETIONS.length)}`;
}
