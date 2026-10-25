/**
 * The organization's default model provider (docs/design/2026-10-model-providers.md):
 * what Manage workspace → Usage → AI default and the `everyapp_ai_*` tools
 * read and write, the same row `everyapp ai default` writes from the
 * terminal (`org_settings.ai_default`). The rule that turns the stored
 * choice and this Worker's settings into the provider that serves is the
 * SDK's (`resolveAiDefault`), run on the env as the AI proxy runs it.
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
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";

/** What the UI and the tools read: the resolution, and whether AI Gateway is in front. */
export interface AiDefaultReport {
  resolution: AiDefaultResolution;
  /** The stored choice as text (`openrouter/anthropic/claude-haiku-5.5`), or null. */
  choice: string | null;
  aiGateway: { on: boolean };
}

const isSet = (name: string) =>
  gatewaySettingIsSet(
    name,
    env as unknown as Readonly<Record<string, unknown>>,
  );

async function get(ctx: Pick<OrgContext, "orgId">): Promise<AiDefaultReport> {
  const stored = await OrgSettingsRepository.getAiDefault(ctx.orgId);
  const choice = parseAiDefaultChoice(stored);
  return {
    resolution: resolveAiDefault({ choice, isSet }),
    choice: choice === null ? null : formatAiDefaultChoice(choice),
    aiGateway: { on: AI_GATEWAY_SETTINGS.every(isSet) },
  };
}

/** The choice as the event carries it. */
const eventChoice = (choice: AiDefaultChoice | null) =>
  choice === null
    ? null
    : { provider: choice.provider, model: choice.model ?? null };

/**
 * Store the organization's choice, or clear it (null). Refuses a choice
 * the default can't be; accepts a provider whose key isn't set (the
 * report says so). Emits `ai.default_changed` when the choice changed and
 * makes the change bind at once on this isolate.
 */
async function set(
  ctx: OrgContext,
  input: { choice: AiDefaultChoice | null },
): Promise<AiDefaultReport> {
  const { choice } = input;
  if (choice) {
    const problem = aiDefaultChoiceProblem(choice);
    if (problem) throw new PublicError("INVALID_INPUT", problem);
  }
  const was = parseAiDefaultChoice(
    await OrgSettingsRepository.getAiDefault(ctx.orgId),
  );
  const stored = choice === null ? null : formatAiDefaultChoice(choice);
  const changed = (was === null ? null : formatAiDefaultChoice(was)) !== stored;
  await OrgSettingsRepository.setAiDefault({
    organizationId: ctx.orgId,
    aiDefault: stored,
    updatedBy: ctx.userId,
  });
  clearAiDefaultCache(ctx.orgId);
  if (changed) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.aiDefaultChanged({
        aiDefault: eventChoice(choice),
        previous: eventChoice(was),
      }),
    }));
  }
  logEvent("ai.default_set", {
    organizationId: ctx.orgId,
    userId: ctx.userId,
    aiDefault: stored,
    changed,
  });
  return get(ctx);
}

export const AiDefaultService = { get, set } as const;
