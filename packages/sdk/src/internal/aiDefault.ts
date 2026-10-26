/**
 * The Gateway's default model provider: what an app that says "I need a
 * chat model" (manifest `ai: { chat: true }`, the SDK's `ai()`, the route
 * `/api/ai/default/…`) is served (docs/design/2026-10-model-providers.md).
 *
 * The default is resolved, never assumed: the operator's choice when one
 * is stored (`everyapp ai default <provider>[/<model>]`, Manage workspace
 * → Usage → AI default), else the shipped order below, first provider
 * whose Gateway settings are all set; with none set, the first of the
 * order with the settings it needs, so "Needs setup" asks for one key.
 * OpenRouter comes first because one key reaches many models; Workers AI
 * second because it needs no provider account (the Gateway's own
 * Cloudflare token), with weaker models; then the single-vendor keys.
 * Cloudflare AI Gateway is never a default: it has no models of its own
 * and fronts whichever provider the default resolves to when
 * `AI_GATEWAY_ID` is set (./capabilities.ts, `aig`).
 *
 * The models resolve the same way: the operator's model setting for the
 * provider (`everyapp ai model <provider> --chat … --embeddings …`,
 * `org_settings.ai_models`), else the catalog entry's seed (`chat.seedModel`,
 * `embeddings.seedModel`). Nothing reads a seed except through here.
 *
 * Everything here is pure: what is set is asked of the caller (`isSet`),
 * which reads the Gateway's env, the Worker's secret names, or `.dev.vars`.
 */
import {
  CATALOG,
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
 * A choice as typed (`everyapp ai default openrouter/anthropic/claude-sonnet-5.5`,
 * the Usage page's dialog, `everyapp_ai_default`): the provider, and the
 * chat model to store for it. The provider goes to `org_settings.ai_default`,
 * the model to that provider's `chat` in `org_settings.ai_models`.
 */
export interface AiDefaultChoice {
  provider: string;
  model?: string;
}

/** The operator's models for one provider; a field left out serves the seed. */
export interface AiModelSetting {
  chat?: string;
  embeddings?: string;
}

/** The operator's models by provider id (`org_settings.ai_models`, JSON). */
export type AiModelSettings = Readonly<Record<string, AiModelSetting>>;

/** A change to one provider's models: a name sets it, null puts the seed back, absent leaves it. */
export interface AiModelPatch {
  chat?: string | null;
  embeddings?: string | null;
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

/**
 * `org_settings.ai_models` as stored: a JSON object of provider id →
 * `{ chat?, embeddings? }`. Anything else (null, malformed JSON, a field
 * that isn't a model name) reads as no setting, so the seed serves.
 */
export function parseAiModelSettings(
  value: string | null | undefined,
): AiModelSettings {
  if (typeof value !== "string" || value.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const settings: Record<string, AiModelSetting> = {};
  for (const [provider, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const setting: AiModelSetting = {};
    for (const kind of ["chat", "embeddings"] as const) {
      const model = (entry as Record<string, unknown>)[kind];
      if (typeof model === "string" && isAiModelName(model)) {
        setting[kind] = model;
      }
    }
    if (setting.chat !== undefined || setting.embeddings !== undefined) {
      settings[provider] = setting;
    }
  }
  return settings;
}

/** The stored text of the settings, providers sorted; null when nothing is set. */
export function formatAiModelSettings(
  settings: AiModelSettings,
): string | null {
  const providers = Object.keys(settings)
    .filter(
      (id) =>
        settings[id]?.chat !== undefined ||
        settings[id]?.embeddings !== undefined,
    )
    .sort();
  if (providers.length === 0) return null;
  return JSON.stringify(
    Object.fromEntries(
      providers.map((id) => {
        const { chat, embeddings } = settings[id]!;
        return [
          id,
          {
            ...(chat === undefined ? {} : { chat }),
            ...(embeddings === undefined ? {} : { embeddings }),
          },
        ];
      }),
    ),
  );
}

/** `settings` with one provider's models changed by `patch`. */
export function withAiModelSetting(
  settings: AiModelSettings,
  provider: string,
  patch: AiModelPatch,
): AiModelSettings {
  const next: AiModelSetting = { ...settings[provider] };
  for (const kind of ["chat", "embeddings"] as const) {
    const value = patch[kind];
    if (value === null) delete next[kind];
    else if (value !== undefined) next[kind] = value;
  }
  const rest = Object.fromEntries(
    Object.entries(settings).filter(([id]) => id !== provider),
  );
  return next.chat === undefined && next.embeddings === undefined
    ? rest
    : { ...rest, [provider]: next };
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

/**
 * The provider id `org_settings.ai_default` holds, or null. The column
 * holds the provider alone (its models are in `ai_models`); text after a
 * first slash is not read.
 */
export function parseAiDefaultProvider(
  value: string | null | undefined,
): string | null {
  return parseAiDefaultChoice(value)?.provider ?? null;
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
 * The Gateway settings an `ai` entry needs before it serves: its key
 * (unless the entry works without one, `authOptional`) and what its URL
 * needs besides (`alsoNeeds`).
 */
export function aiRequiredSettings(capability: AiProviderCapability): string[] {
  return [
    ...(capability.authOptional ? [] : [capability.auth.secret]),
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
  /** The chat model the Gateway fills in when the app names none: the operator's setting, else the seed. */
  model: string;
  /** The embeddings model, the same way; absent when the entry has no embeddings route. */
  embeddingsModel?: string;
  /** The catalog's seeds: what serves where the operator set no model. */
  seed: { chat: string; embeddings?: string };
  /** Through Cloudflare AI Gateway, as things are set now. */
  viaAiGateway: boolean;
  embeddings: boolean;
}

/** Where the resolved default came from. */
export type AiDefaultSource =
  /** The operator's stored choice. */
  | "setting"
  /** The shipped order: the first provider that is configured. */
  | "order"
  /** Nothing is configured: the first of the order, with what to set. */
  | "none";

export interface AiDefaultResolution {
  provider: string;
  label: string;
  /** The chat model the default serves: the operator's setting for the provider, else the seed. */
  model: string;
  /** The embeddings model, the same way; absent when the provider has no embeddings route. */
  embeddingsModel?: string;
  /** The provider's seeds. */
  seed: { chat: string; embeddings?: string };
  source: AiDefaultSource;
  /** Every setting the provider needs is set, so the default serves. */
  configured: boolean;
  /** The Gateway settings the provider needs: what to set when it isn't configured. */
  settings: string[];
  via: "ai-gateway" | "direct";
  chat: AiRoute;
  embeddings?: AiRoute;
  /** Every provider the default could be, in the shipped order, the choice first. */
  candidates: AiDefaultCandidate[];
  /**
   * The stored choice names something the default can't be (an id the
   * catalog doesn't have, an entry with no chat route, the proxy): the
   * order decided instead, and this says why.
   */
  problem?: string;
}

/** The provider's models: the operator's setting, else the seed. */
function modelsOf(
  id: string,
  capability: AiDefaultCapability,
  models: AiModelSettings,
): Pick<AiDefaultCandidate, "model" | "embeddingsModel" | "seed"> {
  const setting = models[id];
  const { chat, embeddings } = capability;
  return {
    model: setting?.chat ?? chat.seedModel,
    ...(embeddings
      ? { embeddingsModel: setting?.embeddings ?? embeddings.seedModel }
      : {}),
    seed: {
      chat: chat.seedModel,
      ...(embeddings ? { embeddings: embeddings.seedModel } : {}),
    },
  };
}

function candidateOf(
  id: string,
  capability: AiDefaultCapability,
  isSet: IsSet,
  models: AiModelSettings,
): AiDefaultCandidate {
  return {
    id,
    label: capability.label,
    settings: aiRequiredSettings(capability),
    configured: aiProviderConfigured(capability, isSet),
    ...modelsOf(id, capability, models),
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
  models: AiModelSettings = {},
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
    return canBeAiDefault(capability)
      ? [candidateOf(id, capability, set, models)]
      : [];
  });
}

/** Why `choice.provider` can't be the default, or null when it can. */
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
  return null;
}

/**
 * Why `patch` can't be stored for `provider`, or null when it can: the
 * provider must be one the default can be, a model name must be a model
 * name, and an embeddings model needs the entry's embeddings route.
 */
export function aiModelPatchProblem(
  provider: string,
  patch: AiModelPatch,
  lookup: CapabilityLookup = CATALOG,
): string | null {
  const why = aiDefaultChoiceProblem({ provider }, lookup);
  if (why) return why;
  const capability = lookup.get(provider);
  if (!canBeAiDefault(capability)) return `${provider} can't serve the default`;
  for (const kind of ["chat", "embeddings"] as const) {
    const value = patch[kind];
    if (typeof value === "string" && !isAiModelName(value)) {
      return `${JSON.stringify(value)} isn't a model id: 1 to 200 characters, no surrounding spaces`;
    }
  }
  if (typeof patch.embeddings === "string" && !capability.embeddings) {
    return `${capability.label} has no embeddings route, so it serves no embeddings model`;
  }
  return null;
}

/**
 * The Gateway's effective default, from the stored choice (or none) and
 * what is set. A choice that names a provider which isn't configured
 * still wins (the operator chose it: `configured` is false and `settings`
 * says what to set); a choice the default can't be is reported as
 * `problem` and the order decides.
 */
export function resolveAiDefault(input: {
  /** The stored provider (`org_settings.ai_default`), or null for the shipped order. */
  provider: string | null;
  /** The operator's models by provider (`org_settings.ai_models`); none: the seeds serve. */
  models?: AiModelSettings;
  isSet: IsSet;
  lookup?: CapabilityLookup;
}): AiDefaultResolution {
  const lookup = input.lookup ?? CATALOG;
  const models = input.models ?? {};
  const { isSet } = input;
  const candidates = aiDefaultCandidates(isSet, lookup, models);
  const resolve = (
    id: string,
    capability: AiDefaultCapability,
    source: AiDefaultSource,
    problem?: string,
  ): AiDefaultResolution => ({
    provider: id,
    label: capability.label,
    ...modelsOf(id, capability, models),
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
    ...(problem ? { problem } : {}),
  });

  let problem: string | undefined;
  if (input.provider) {
    const capability = lookup.get(input.provider);
    const why = aiDefaultChoiceProblem({ provider: input.provider }, lookup);
    if (!why && canBeAiDefault(capability)) {
      return resolve(input.provider, capability, "setting");
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
  return resolve(first.id, capability, configured ? "order" : "none", problem);
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
