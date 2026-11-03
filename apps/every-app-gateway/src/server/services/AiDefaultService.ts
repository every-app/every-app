/**
 * The workspace's default model (docs/design/2026-10-model-providers.md):
 * what Manage workspace → Usage → AI default and the `everyapp_ai_*` tools
 * read and write, the same setting `everyapp ai default` writes from the
 * terminal (`org_settings.ai_default`, `<provider>[/<model>]`). The rule
 * that turns it and this Worker's settings into the provider and model
 * that serve is the SDK's (`resolveAiDefault`: the setting, else the
 * first provider of the order whose key is set; the provider's seed where
 * the setting names no model), run on the env as the AI proxy runs it.
 */
import { env } from "cloudflare:workers";
import { logEvent } from "@every-app/perimeter";
import {
  AI_GATEWAY_SETTINGS,
  aiDefaultChoiceProblem,
  formatAiDefaultChoice,
  parseAiDefaultChoice,
  resolveAiDefault,
  type AiDefaultChoice,
  type AiDefaultResolution,
} from "@every-app/sdk/internal";
import { clearAiDefaultCache, gatewaySettingIsSet } from "@/server/ai-default";
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
  /** The stored setting as text (`openrouter/anthropic/claude-haiku-5.5`, or a provider alone), or null. */
  choice: string | null;
  aiGateway: { on: boolean };
}

const isSet = (name: string) =>
  gatewaySettingIsSet(
    name,
    env as unknown as Readonly<Record<string, unknown>>,
  );

async function stored(orgId: string): Promise<AiDefaultChoice | null> {
  return parseAiDefaultChoice(await OrgSettingsRepository.getAiDefault(orgId));
}

async function reportOf(
  choice: AiDefaultChoice | null,
): Promise<AiDefaultReport> {
  return {
    resolution: resolveAiDefault({
      choice,
      isSet,
      lookup: await gatewayProviders(),
    }),
    choice: choice === null ? null : formatAiDefaultChoice(choice),
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

const text = (value: AiDefaultChoice | null) =>
  value === null ? null : formatAiDefaultChoice(value);

/**
 * Store the workspace's default model, or clear it (null: the shipped
 * order decides). Refuses a choice the default can't be; accepts a
 * provider whose key isn't set (the report says so). Emits
 * `ai.default_changed` when the setting changed and makes the change bind
 * at once on this isolate.
 */
async function set(
  ctx: OrgContext,
  input: { choice: AiDefaultChoice | null },
): Promise<AiDefaultReport> {
  const { choice } = input;
  if (choice) {
    const problem = aiDefaultChoiceProblem(choice, await gatewayProviders());
    if (problem) throw new PublicError("INVALID_INPUT", problem);
  }
  const before = await stored(ctx.orgId);
  const changed = text(before) !== text(choice);
  await OrgSettingsRepository.setAiDefault({
    organizationId: ctx.orgId,
    aiDefault: text(choice),
    updatedBy: ctx.userId,
  });
  clearAiDefaultCache(ctx.orgId);
  if (changed) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.aiDefaultChanged({
        aiDefault: eventChoice(choice),
        previous: eventChoice(before),
      }),
    }));
  }
  logEvent("ai.default_set", {
    organizationId: ctx.orgId,
    userId: ctx.userId,
    aiDefault: text(choice),
    changed,
  });
  return reportOf(choice);
}

export const AiDefaultService = { get, set } as const;
