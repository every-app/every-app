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
import { AI_DEFAULT_MODEL, AI_DEFAULT_PROVIDER } from "../internal/index.js";
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
export function ai(options: CreateGatewayFetchOptions): AiClient {
  return {
    baseURL: AI_DEFAULT_BASE_URL,
    fetch: createGatewayFetch(options),
    model: AI_DEFAULT_MODEL,
    chatCompletionsUrl: `${AI_DEFAULT_BASE_URL}/chat/completions`,
    embeddingsUrl: `${AI_DEFAULT_BASE_URL}/embeddings`,
  };
}
