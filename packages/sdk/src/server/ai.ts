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
} from "../internal/index.js";
import {
  BINDING_ORIGIN,
  createGatewayFetch,
  type CreateGatewayFetchOptions,
} from "./gatewayFetch.js";

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
