/**
 * The Gateway's default model provider: what an app that says "I need a
 * chat model" (manifest `ai: { chat: true }`, the SDK's `aiBaseUrl()`, the route
 * `/api/ai/default/…`) is served (docs/design/2026-10-model-providers.md).
 *
 * The default is one setting per workspace, `<provider>[/<model>]`
 * (`everyapp ai default`, Manage workspace → Usage → AI default, the
 * `everyapp_ai_default` tool; `org_settings.ai_default`): the provider is
 * everything up to the first slash, the model everything after it. With
 * no setting, the shipped order below decides: the first provider whose
 * Gateway settings are all set; with none set, the first of the order
 * with the settings it needs, so "Needs setup" asks for one key.
 * OpenRouter comes first because one key reaches many models; Workers AI
 * second because it needs no provider account (the Gateway's own
 * Cloudflare token), with weaker models; then the single-vendor keys.
 * Cloudflare AI Gateway is never a default: it has no models of its own
 * and fronts whichever provider the default resolves to when
 * `AI_GATEWAY_ID` is set (./capabilities.ts, `aig`).
 *
 * The chat model is the setting's model, else the catalog entry's seed
 * (`chat.seedModel`); embeddings always use the entry's seed
 * (`embeddings.seedModel`). Nothing reads a seed except through here.
 *
 * Everything here is pure: what is set is asked of the caller (`isSet`),
 * which reads the Gateway's env, the Worker's secret names, or `.dev.vars`.
 */
import {
  CATALOG,
  authSettingNames,
  type AiProviderCapability,
  type AiRoute,
  type Capability,
  type CapabilityLookup,
} from "./capabilities.js";

/** The reserved provider id apps call for the default: `/api/ai/default/…`. */
export const AI_DEFAULT_PROVIDER = "default";

/** The catalog id of Cloudflare AI Gateway, the proxy entry. */
export const AI_GATEWAY_PROVIDER = "ai-gateway";

/** The settings that make AI Gateway front the providers that have a slug. */
export const AI_GATEWAY_SETTINGS = [
  "AI_GATEWAY_ID",
  "CLOUDFLARE_ACCOUNT_ID",
] as const;

/**
 * The shipped order: the provider the default resolves to when the
 * operator chose none, the first of these whose settings are set.
 */
export const AI_DEFAULT_ORDER: readonly string[] = [
  "openrouter",
  "workers-ai",
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "gemini",
];

/** The model name an app sends to mean "the default's model". */
export const AI_DEFAULT_MODEL = "default";

/** The paths an app calls under `/api/ai/default`, OpenAI-shaped. */
export const AI_DEFAULT_ROUTES = {
  chat: "/v1/chat/completions",
  embeddings: "/v1/embeddings",
} as const;

export type AiDefaultRoute = keyof typeof AI_DEFAULT_ROUTES;

/**
 * The workspace's one setting, as typed (`everyapp ai default
 * openrouter/anthropic/claude-sonnet-5.5`, the Usage page's dialog,
 * `everyapp_ai_default`) and stored (`org_settings.ai_default`): the
 * provider, and the chat model to fill in when an app names none (the
 * provider's seed when left out).
 */
export interface AiDefaultChoice {
  provider: string;
  model?: string;
}

/** Whether `value` can be a model id: 1 to 200 characters, no surrounding or control whitespace. */
export function isAiModelName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** A choice must name a provider id; the model is free text after the first slash. */
const CHOICE = /^([a-z][a-z0-9-]{1,39})(?:\/(.{1,200}))?$/;

/**
 * `openrouter` or `openrouter/anthropic/claude-haiku-5.5` as typed:
 * the provider id up to the first slash, the model after it (a model id
 * may hold slashes of its own). Null for blank or malformed text.
 */
export function parseAiDefaultChoice(
  value: string | null | undefined,
): AiDefaultChoice | null {
  if (typeof value !== "string") return null;
  const match = CHOICE.exec(value.trim());
  if (!match) return null;
  const model = match[2]?.trim();
  return model ? { provider: match[1]!, model } : { provider: match[1]! };
}

/** The text of a choice: `provider` or `provider/model`. */
export function formatAiDefaultChoice(choice: AiDefaultChoice): string {
  return choice.model ? `${choice.provider}/${choice.model}` : choice.provider;
}

/** Whether `name` holds a value, as the Gateway's env or a secret list says. */
export type IsSet = (name: string) => boolean;

/** An `ai` entry the default may resolve to: not the proxy, with a chat route. */
export type AiDefaultCapability = AiProviderCapability & { chat: AiRoute };

export function canBeAiDefault(
  capability: Capability | undefined,
): capability is AiDefaultCapability {
  return (
    capability?.mode === "ai" &&
    capability.kind !== "proxy" &&
    capability.chat !== undefined
  );
}

/**
 * The Gateway settings an `ai` entry needs before it serves: every setting
 * its `auth` names, the key and a Basic username held as a setting (unless
 * the entry works without them, `authOptional`), and what its URL needs
 * besides (`alsoNeeds`).
 */
export function aiRequiredSettings(capability: AiProviderCapability): string[] {
  return [
    ...(capability.authOptional ? [] : authSettingNames(capability.auth)),
    ...(capability.alsoNeeds ?? []),
  ];
}

/** Whether every setting the entry needs is set. */
export function aiProviderConfigured(
  capability: AiProviderCapability,
  isSet: IsSet,
): boolean {
  return aiRequiredSettings(capability).every((name) => isSet(name));
}

/** Whether AI Gateway fronts calls: its id and the account are set. */
export function aiGatewayConfigured(isSet: IsSet): boolean {
  return AI_GATEWAY_SETTINGS.every((name) => isSet(name));
}

/** Whether a call to `capability` goes through AI Gateway: it is configured and the entry has a slug. */
export function viaAiGateway(
  capability: AiProviderCapability,
  isSet: IsSet,
): boolean {
  return capability.aig !== undefined && aiGatewayConfigured(isSet);
}

/** One provider the default may resolve to, with its state on this Gateway. */
export interface AiDefaultCandidate {
  id: string;
  label: string;
  /** The Gateway settings it needs; what to set when it isn't configured. */
  settings: string[];
  configured: boolean;
  /** The catalog's chat model (the seed): what it serves when chosen without a model. */
  model: string;
  /** The catalog's embeddings model; absent when the entry has no embeddings route. */
  embeddingsModel?: string;
  /** Through Cloudflare AI Gateway, as things are set now. */
  viaAiGateway: boolean;
  embeddings: boolean;
}

/** Where the resolved default came from. */
export type AiDefaultSource =
  /** The workspace's setting. */
  | "setting"
  /** The shipped order: the first provider that is configured. */
  | "order"
  /** Nothing is configured: the first of the order, with what to set. */
  | "none";

export interface AiDefaultResolution {
  provider: string;
  label: string;
  /** The chat model the default serves: the setting's model, else the provider's seed. */
  model: string;
  /** The embeddings model (the provider's seed); absent when the provider has no embeddings route. */
  embeddingsModel?: string;
  source: AiDefaultSource;
  /** Every setting the provider needs is set, so the default serves. */
  configured: boolean;
  /** The Gateway settings the provider needs: what to set when it isn't configured. */
  settings: string[];
  via: "ai-gateway" | "direct";
  chat: AiRoute;
  embeddings?: AiRoute;
  /** Every provider the default could be, in the shipped order, the chosen one first. */
  candidates: AiDefaultCandidate[];
  /**
   * The setting names something the default can't be (an id the catalog
   * doesn't have, an entry with no chat route, the proxy): the order
   * decided instead, and this says why.
   */
  problem?: string;
}

function candidateOf(
  id: string,
  capability: AiDefaultCapability,
  isSet: IsSet,
): AiDefaultCandidate {
  return {
    id,
    label: capability.label,
    settings: aiRequiredSettings(capability),
    configured: aiProviderConfigured(capability, isSet),
    model: capability.chat.seedModel,
    ...(capability.embeddings
      ? { embeddingsModel: capability.embeddings.seedModel }
      : {}),
    viaAiGateway: viaAiGateway(capability, isSet),
    embeddings: capability.embeddings !== undefined,
  };
}

/**
 * Every provider the default may resolve to: the shipped order first,
 * then any other `ai` entry of `lookup` with a chat route (a registered
 * row, one day), each with its state.
 */
export function aiDefaultCandidates(
  isSet: IsSet,
  lookup: CapabilityLookup = CATALOG,
): AiDefaultCandidate[] {
  const ids = [
    ...AI_DEFAULT_ORDER,
    ...lookup.ids().filter((id) => !AI_DEFAULT_ORDER.includes(id)),
  ];
  return ids.flatMap((id) => {
    const capability = lookup.get(id);
    // A registered row whose key isn't bound to the hosts it has now reads
    // as unset everywhere (`providers.value-bound-to-hosts`).
    const set = lookup.bound && !lookup.bound(id) ? () => false : isSet;
    return canBeAiDefault(capability) ? [candidateOf(id, capability, set)] : [];
  });
}

/** Why `choice` can't be the default, or null when it can. */
export function aiDefaultChoiceProblem(
  choice: AiDefaultChoice,
  lookup: CapabilityLookup = CATALOG,
): string | null {
  const capability = lookup.get(choice.provider);
  if (!capability)
    return `${choice.provider} isn't a provider this Gateway knows`;
  if (capability.mode !== "ai") {
    return `${choice.provider} is an API provider, not a model provider`;
  }
  if (capability.kind === "proxy") {
    return `${capability.label} fronts the model providers and serves no models of its own; set a provider, and turn the gateway on with everyapp ai gateway on`;
  }
  if (!capability.chat) {
    return `${capability.label} has no OpenAI-shaped chat route, so it can't serve the default; an app pins it by listing it under providers`;
  }
  if (choice.model !== undefined && !isAiModelName(choice.model)) {
    return `${JSON.stringify(choice.model)} isn't a model id: 1 to 200 characters, no surrounding spaces`;
  }
  return null;
}

/**
 * The Gateway's effective default, from the workspace's setting (or none)
 * and what is set. A setting that names a provider which isn't configured
 * still wins (the operator chose it: `configured` is false and `settings`
 * says what to set); a setting the default can't be is reported as
 * `problem` and the order decides.
 */
export function resolveAiDefault(input: {
  /** The workspace's setting (`org_settings.ai_default`), or null for the shipped order. */
  choice: AiDefaultChoice | null;
  isSet: IsSet;
  lookup?: CapabilityLookup;
}): AiDefaultResolution {
  const lookup = input.lookup ?? CATALOG;
  const { isSet, choice } = input;
  const candidates = aiDefaultCandidates(isSet, lookup);
  const resolve = (
    id: string,
    capability: AiDefaultCapability,
    source: AiDefaultSource,
    extra: { model?: string; problem?: string } = {},
  ): AiDefaultResolution => ({
    provider: id,
    label: capability.label,
    model: extra.model ?? capability.chat.seedModel,
    ...(capability.embeddings
      ? { embeddingsModel: capability.embeddings.seedModel }
      : {}),
    source,
    configured: aiProviderConfigured(capability, isSet),
    settings: aiRequiredSettings(capability),
    via: viaAiGateway(capability, isSet) ? "ai-gateway" : "direct",
    chat: capability.chat,
    ...(capability.embeddings ? { embeddings: capability.embeddings } : {}),
    candidates: [
      ...candidates.filter((candidate) => candidate.id === id),
      ...candidates.filter((candidate) => candidate.id !== id),
    ],
    ...(extra.problem ? { problem: extra.problem } : {}),
  });

  let problem: string | undefined;
  if (choice) {
    const capability = lookup.get(choice.provider);
    const why = aiDefaultChoiceProblem(choice, lookup);
    if (!why && canBeAiDefault(capability)) {
      return resolve(choice.provider, capability, "setting", {
        ...(choice.model ? { model: choice.model } : {}),
      });
    }
    problem = why ?? undefined;
  }
  const configured = candidates.find((candidate) => candidate.configured);
  const first = configured ?? candidates[0];
  if (!first) {
    throw new Error("the catalog has no AI provider with a chat route");
  }
  const capability = lookup.get(first.id);
  if (!canBeAiDefault(capability)) throw new Error("unreachable");
  return resolve(first.id, capability, configured ? "order" : "none", {
    ...(problem ? { problem } : {}),
  });
}

/**
 * The sentence setup shows for an unconfigured default: the one key to
 * set, and the alternatives in the order.
 */
export function aiDefaultSetupHint(resolution: AiDefaultResolution): string {
  const others = resolution.candidates
    .filter((candidate) => candidate.id !== resolution.provider)
    .slice(0, 3)
    .map(
      (candidate) => `${candidate.label} (${candidate.settings.join(" and ")})`,
    );
  const head =
    resolution.source === "setting"
      ? `The Gateway's default model provider is ${resolution.label}; set ${resolution.settings.join(" and ")}.`
      : `Any one model provider's key makes the app work; ${resolution.label} is first in the order: set ${resolution.settings.join(" and ")}.`;
  return others.length > 0
    ? `${head} Or another: ${others.join(", ")}; pick one with everyapp ai default <provider>.`
    : head;
}
