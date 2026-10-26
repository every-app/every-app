/**
 * The organization's default model provider and default models
 * (docs/design/2026-10-model-providers.md): what Manage workspace → Usage
 * → AI default and the `everyapp_ai_*` tools read and write, the same row
 * `everyapp ai default` and `everyapp ai model` write from the terminal
 * (`org_settings.ai_default`, the provider; `org_settings.ai_models`, the
 * operator's chat and embeddings model per provider). The rule that turns
 * them and this Worker's settings into the provider and models that serve
 * is the SDK's (`resolveAiDefault`: the operator's model, else the
 * catalog's seed), run on the env as the AI proxy runs it.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  AI_GATEWAY_SETTINGS,
  aiDefaultChoiceProblem,
  aiModelPatchProblem,
  formatAiDefaultChoice,
  formatAiModelSettings,
  resolveAiDefault,
  withAiModelSetting,
  type AiDefaultChoice,
  type AiDefaultResolution,
  type AiModelPatch,
  type AiModelSettings,
} from "@every-app/sdk/internal";
import {
  aiDefaultSettingsOf,
  clearAiDefaultCache,
  gatewaySettingIsSet,
  type AiDefaultSettings,
} from "@/server/ai-default";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor } from "@/server/events/subjects";
import type { OrgContext } from "@/server/organization/orgContext";
import { gatewayProviders } from "@/server/providers";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";

/** What the UI and the tools read: the resolution, and whether AI Gateway is in front. */
export interface AiDefaultReport {
  resolution: AiDefaultResolution;
  /** The stored choice as text (`openrouter/anthropic/claude-haiku-5.5`: the provider and its chat model setting), or null. */
  choice: string | null;
  /** The operator's model settings by provider; a provider left out serves its seeds. */
  models: AiModelSettings;
  aiGateway: { on: boolean };
}

const isSet = (name: string) =>
  gatewaySettingIsSet(
    name,
    env as unknown as Readonly<Record<string, unknown>>,
  );

/** The stored choice as the UI and the event read it: the provider, with its chat model setting. */
function choiceOf(settings: AiDefaultSettings): AiDefaultChoice | null {
  if (settings.provider === null) return null;
  const model = settings.models[settings.provider]?.chat;
  return { provider: settings.provider, ...(model ? { model } : {}) };
}

async function stored(orgId: string): Promise<AiDefaultSettings> {
  return aiDefaultSettingsOf(await OrgSettingsRepository.getAiSettings(orgId));
}

async function reportOf(settings: AiDefaultSettings): Promise<AiDefaultReport> {
  const choice = choiceOf(settings);
  return {
    resolution: resolveAiDefault({
      ...settings,
      isSet,
      lookup: await gatewayProviders(),
    }),
    choice: choice === null ? null : formatAiDefaultChoice(choice),
    models: settings.models,
    aiGateway: { on: AI_GATEWAY_SETTINGS.every(isSet) },
  };
}

async function get(ctx: Pick<OrgContext, "orgId">): Promise<AiDefaultReport> {
  return reportOf(await stored(ctx.orgId));
}

/** The choice as the event carries it. */
const eventChoice = (choice: AiDefaultChoice | null) =>
  choice === null
    ? null
    : { provider: choice.provider, model: choice.model ?? null };

async function write(ctx: OrgContext, next: AiDefaultSettings): Promise<void> {
  await OrgSettingsRepository.setAiSettings({
    organizationId: ctx.orgId,
    aiDefault: next.provider,
    aiModels: formatAiModelSettings(next.models),
    updatedBy: ctx.userId,
  });
  clearAiDefaultCache(ctx.orgId);
}

/**
 * Store the organization's choice, or clear it (null). The provider goes
 * to `ai_default`; a model with it becomes that provider's chat model
 * setting (without one, the provider's models stay as they are). Refuses
 * a choice the default can't be; accepts a provider whose key isn't set
 * (the report says so). Emits `ai.default_changed` when the choice
 * changed and makes the change bind at once on this isolate.
 */
async function set(
  ctx: OrgContext,
  input: { choice: AiDefaultChoice | null },
): Promise<AiDefaultReport> {
  const { choice } = input;
  if (choice) {
    const problem =
      aiDefaultChoiceProblem(choice, await gatewayProviders()) ??
      (choice.model
        ? aiModelPatchProblem(choice.provider, { chat: choice.model })
        : null);
    if (problem) throw new PublicError("INVALID_INPUT", problem);
  }
  const was = await stored(ctx.orgId);
  const next: AiDefaultSettings =
    choice === null
      ? { provider: null, models: was.models }
      : {
          provider: choice.provider,
          models: choice.model
            ? withAiModelSetting(was.models, choice.provider, {
                chat: choice.model,
              })
            : was.models,
        };
  const before = choiceOf(was);
  const after = choiceOf(next);
  const text = (value: AiDefaultChoice | null) =>
    value === null ? null : formatAiDefaultChoice(value);
  const changed = text(before) !== text(after);
  await write(ctx, next);
  if (changed) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.aiDefaultChanged({
        aiDefault: eventChoice(after),
        previous: eventChoice(before),
      }),
    }));
  }
  logEvent("ai.default_set", {
    organizationId: ctx.orgId,
    userId: ctx.userId,
    aiDefault: text(after),
    changed,
  });
  return reportOf(next);
}

/**
 * Set or reset one provider's default models (`everyapp ai model`,
 * `everyapp_ai_model`): a name stores it, null puts the seed back, a
 * field left out stays. Refuses a provider the default can't be and an
 * embeddings model for a provider without embeddings. Emits
 * `ai.model_changed` when a model changed.
 */
async function setModels(
  ctx: OrgContext,
  input: { provider: string; patch: AiModelPatch },
): Promise<AiDefaultReport> {
  const { provider, patch } = input;
  const problem = aiModelPatchProblem(provider, patch);
  if (problem) throw new PublicError("INVALID_INPUT", problem);
  const was = await stored(ctx.orgId);
  const next: AiDefaultSettings = {
    provider: was.provider,
    models: withAiModelSetting(was.models, provider, patch),
  };
  const before = was.models[provider] ?? {};
  const after = next.models[provider] ?? {};
  const changed =
    before.chat !== after.chat || before.embeddings !== after.embeddings;
  await write(ctx, next);
  if (changed) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.aiModelChanged({
        provider,
        models: {
          chat: after.chat ?? null,
          embeddings: after.embeddings ?? null,
        },
        previous: {
          chat: before.chat ?? null,
          embeddings: before.embeddings ?? null,
        },
      }),
    }));
  }
  logEvent("ai.model_set", {
    organizationId: ctx.orgId,
    userId: ctx.userId,
    provider,
    changed,
  });
  return reportOf(next);
}

export const AiDefaultService = { get, set, setModels } as const;
