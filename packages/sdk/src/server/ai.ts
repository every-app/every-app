/**
 * Where an app's model calls go behind the Gateway, for an OpenAI client's
 * `baseURL` or a plain `fetch`, both sent with `createGatewayFetch()`:
 * `aiBaseUrl("openai")` (a provider's OpenAI-compatible base), `aiBaseUrl()`
 * (the Gateway's default model, `ai: { chat: true }`: send `model:
 * "default"` or none and the Gateway fills in the workspace's model), and
 * `providerBaseUrl("openai")` (a provider's root, for its own paths).
 *
 *   const client = new OpenAI({
 *     baseURL: aiBaseUrl(),
 *     fetch: createGatewayFetch({ env }),
 *     apiKey: "gateway-managed",
 *   });
 *   await client.chat.completions.create({ model: "default", messages });
 */
import {
  AI_DEFAULT_PROVIDER,
  CATALOG,
  ConfigurationError,
} from "../internal/index.js";
import { BINDING_ORIGIN } from "./gatewayFetch.js";

/** The base URL of the default route, `…/api/ai/default/v1`. */
const AI_DEFAULT_BASE_URL = `${BINDING_ORIGIN}/api/ai/${AI_DEFAULT_PROVIDER}/v1`;

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
 * `default` (the default, and what it is when left out) is
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
