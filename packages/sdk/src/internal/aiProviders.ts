/**
 * The gateway's AI providers as the SDK's local-dev fallback reaches them:
 * with no gateway binding, a developer's own key, under the name of the
 * gateway secret that holds it, goes to the provider directly. Deployed
 * apps always go through the gateway, which holds the real keys.
 */
export const DEV_AI_PROVIDERS = {
  openai: { origin: "https://api.openai.com", keyEnv: "OPENAI_API_KEY" },
  openrouter: { origin: "https://openrouter.ai", keyEnv: "OPENROUTER_API_KEY" },
} as const satisfies Record<string, { origin: string; keyEnv: string }>;

export type DevAiProvider = keyof typeof DEV_AI_PROVIDERS;

export function devAiProvider(
  name: string,
): (typeof DEV_AI_PROVIDERS)[DevAiProvider] | undefined {
  return Object.hasOwn(DEV_AI_PROVIDERS, name)
    ? DEV_AI_PROVIDERS[name as DevAiProvider]
    : undefined;
}
