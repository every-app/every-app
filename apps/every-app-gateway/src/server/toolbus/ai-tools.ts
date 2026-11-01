/**
 * The handlers behind the model-provider tools on the gateway's own /mcp
 * (`everyapp_ai_show`, `everyapp_ai_default`, `everyapp_ai_model`;
 * docs/design/2026-10-model-providers.md), run like the workspace tools
 * (workspace-tools.ts spreads them into its handler map) for a resolved
 * caller. Whether each candidate's settings are set shows to owners and
 * admins only; a member sees the provider, the model and the order.
 */
import type { JsonObject, McpPrincipal } from "@every-app/toolbus";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import {
  AiDefaultService,
  type AiDefaultReport,
} from "@/server/services/AiDefaultService";

type Handler = (
  ctx: OrgContext,
  args: JsonObject,
  principal: McpPrincipal,
) => Promise<JsonObject>;

/** The report as a tool answers it; `configured` and `settings` for owners and admins only. */
function aiReportData(report: AiDefaultReport, admin: boolean): JsonObject {
  const { resolution } = report;
  const candidate = (
    entry: AiDefaultReport["resolution"]["candidates"][number],
  ) => ({
    id: entry.id,
    label: entry.label,
    model: entry.model,
    ...(entry.embeddingsModel
      ? { embeddingsModel: entry.embeddingsModel }
      : {}),
    seed: entry.seed,
    embeddings: entry.embeddings,
    viaAiGateway: entry.viaAiGateway,
    ...(admin
      ? { configured: entry.configured, settings: entry.settings }
      : {}),
  });
  return {
    provider: resolution.provider,
    label: resolution.label,
    model: resolution.model,
    ...(resolution.embeddingsModel
      ? { embeddingsModel: resolution.embeddingsModel }
      : {}),
    seed: resolution.seed,
    source: resolution.source,
    via: resolution.via,
    choice: report.choice,
    models: report.models as JsonObject,
    ...(admin
      ? { configured: resolution.configured, settings: resolution.settings }
      : {}),
    ...(resolution.problem ? { problem: resolution.problem } : {}),
    candidates: resolution.candidates.map(candidate),
    aiGateway: report.aiGateway,
  };
}

const isAdmin = (ctx: OrgContext) =>
  ctx.role === "owner" || ctx.role === "admin";

export const AI_HANDLERS: Record<string, Handler> = {
  async ai_show(ctx) {
    return aiReportData(await AiDefaultService.get(ctx), isAdmin(ctx));
  },

  async ai_default(ctx, args) {
    const provider =
      typeof args["provider"] === "string" ? args["provider"].trim() : "";
    const model = typeof args["model"] === "string" ? args["model"].trim() : "";
    const clear = args["clear"] === true;
    if (clear && provider) {
      throw new PublicError(
        "INVALID_INPUT",
        "give provider or clear, not both",
      );
    }
    if (!clear && !provider) {
      throw new PublicError(
        "INVALID_INPUT",
        "provider is required (or clear: true)",
      );
    }
    const report = await AiDefaultService.set(ctx, {
      choice: clear ? null : { provider, ...(model ? { model } : {}) },
    });
    return aiReportData(report, true);
  },

  async ai_model(ctx, args) {
    const provider =
      typeof args["provider"] === "string" ? args["provider"].trim() : "";
    if (!provider) {
      throw new PublicError("INVALID_INPUT", "provider is required");
    }
    const field = (name: "chat" | "embeddings"): string | null | undefined => {
      const value = args[name];
      if (value === null) return null;
      if (typeof value === "string") return value.trim();
      return undefined;
    };
    const chat = field("chat");
    const embeddings = field("embeddings");
    if (chat === undefined && embeddings === undefined) {
      throw new PublicError(
        "INVALID_INPUT",
        "give chat or embeddings (a model name, or null for the catalog's seed)",
      );
    }
    const report = await AiDefaultService.setModels(ctx, {
      provider,
      patch: {
        ...(chat === undefined ? {} : { chat }),
        ...(embeddings === undefined ? {} : { embeddings }),
      },
    });
    return aiReportData(report, true);
  },
};
