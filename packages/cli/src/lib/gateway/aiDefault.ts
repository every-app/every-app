/**
 * `everyapp ai …`: the Gateway's default model provider and default
 * models from the terminal (docs/design/2026-10-model-providers.md), read
 * and written in the Gateway's D1 under the operator's Cloudflare login
 * like every workspace change (ADR-0003): `org_settings.ai_default` (the
 * provider) and `org_settings.ai_models` (the operator's chat and
 * embeddings model per provider, JSON) on the install organization, as
 * Manage workspace → Usage → AI default and the `everyapp_ai_*` tools
 * write them for a signed-in admin (AiDefaultService in the Worker). The
 * rule that turns them and the Gateway's settings into the provider and
 * models that serve is the SDK's (`resolveAiDefault`: the operator's
 * model, else the catalog's seed), run here on the Gateway Worker's
 * secret names (never values) and by the Gateway on its env.
 *
 * `setAiDefault` queues `ai.default_changed` and `setAiModels` queues
 * `ai.model_changed` in the batch that writes the row, only when what
 * they describe changed, and never delete a row that still holds a cap
 * (the defaults share `org_settings`). A Gateway from before migration
 * 0019 has no `ai_models` column: `ai default` and `ai model` refuse with
 * the command that brings it up to date; `ai show` reads it as no
 * setting (and, before 0017, no choice).
 */
import {
  aiDefaultChoiceProblem,
  aiModelPatchProblem,
  formatAiDefaultChoice,
  formatAiModelSettings,
  parseAiDefaultChoice,
  parseAiDefaultProvider,
  parseAiModelSettings,
  resolveAiDefault,
  withAiModelSetting,
  AI_GATEWAY_SETTINGS,
  type AiDefaultChoice,
  type AiDefaultResolution,
  type AiModelPatch,
  type AiModelSettings,
} from "@every-app/sdk/internal";
import type { D1Database, D1Statement } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { listGatewaySecretNames } from "@/lib/app/settings";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { emptyOrgSettingsSql, hasCostCaps } from "./costCaps";
import { operatorActor, queueEventFromCli } from "./events";
import type { Workspace } from "./workspace";

const orgSettingsColumns = new WeakMap<D1Database, Promise<string[]>>();

/** The columns of the Gateway's `org_settings`, asked of each database once. */
function columnsOf(db: D1Database): Promise<string[]> {
  let known = orgSettingsColumns.get(db);
  if (!known) {
    known = db
      .run([{ sql: "PRAGMA table_info(org_settings)" }])
      .then(([rows = []]) => rows.map((row) => String(row["name"])));
    orgSettingsColumns.set(db, known);
  }
  return known;
}

/** Whether the Gateway's `org_settings` has `ai_default` (migration 0017, 2026-10-25). */
export async function hasAiDefault(db: D1Database): Promise<boolean> {
  return (await columnsOf(db)).includes("ai_default");
}

/** Whether the Gateway's `org_settings` has `ai_models` (migration 0019, 2026-10-26). */
export async function hasAiModels(db: D1Database): Promise<boolean> {
  return (await columnsOf(db)).includes("ai_models");
}

/** Refuse a write on a Gateway from before the model settings. */
async function requireAiModels(db: D1Database): Promise<void> {
  if (await hasAiModels(db)) return;
  throw new EveryAppError(
    "GATEWAY_PREDATES_AI_DEFAULT",
    "The Gateway predates the default model settings\nIts database has no ai_models column until the Gateway is updated to a release that has it.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

/** What the organization stored: the provider and the models (each empty on a Gateway without the column). */
interface StoredAi {
  provider: string | null;
  models: AiModelSettings;
}

async function readAi(db: D1Database, organizationId: string): Promise<StoredAi> {
  const [provider, models] = await Promise.all([hasAiDefault(db), hasAiModels(db)]);
  if (!provider) return { provider: null, models: {} };
  const [rows = []] = await db.run([
    {
      sql: `SELECT ai_default${models ? ", ai_models" : ""} FROM org_settings WHERE organization_id = ?`,
      params: [organizationId],
    },
  ]);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    provider: parseAiDefaultProvider(text(rows[0]?.["ai_default"])),
    models: parseAiModelSettings(text(rows[0]?.["ai_models"])),
  };
}

/** The stored choice as it reads: the provider, with its chat model setting. */
function choiceOf(stored: StoredAi): AiDefaultChoice | null {
  if (stored.provider === null) return null;
  const model = stored.models[stored.provider]?.chat;
  return { provider: stored.provider, ...(model ? { model } : {}) };
}

/** The batch's upsert of both columns and the DELETE of a row left empty. */
async function writeAi(ws: Workspace, next: StoredAi): Promise<D1Statement[]> {
  const org = ws.organization.id;
  return [
    {
      sql: `INSERT INTO org_settings (organization_id, ai_default, ai_models, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4, ?5)
ON CONFLICT (organization_id) DO UPDATE SET ai_default = ?2, ai_models = ?3, updated_at = ?4, updated_by = ?5`,
      params: [org, next.provider, formatAiModelSettings(next.models), ws.now, ws.operator.userId],
    },
    // A row with no default of any kind needs no row (the dollar cap's
    // column counts on a Gateway that has it).
    {
      sql: `DELETE FROM org_settings WHERE organization_id = ? AND ${emptyOrgSettingsSql({ cost: await hasCostCaps(ws.db), ai: true, models: true })}`,
      params: [org],
    },
  ];
}

/** What `setAiDefault` answers: the choice now, the choice before, and whether the write changed it. */
interface AiDefaultChange {
  choice: AiDefaultChoice | null;
  was: AiDefaultChoice | null;
  changed: boolean;
}

/** The choice as the event carries it: provider and model, model null when the seed serves. */
const eventChoice = (choice: AiDefaultChoice | null) =>
  choice === null ? null : { provider: choice.provider, model: choice.model ?? null };

const choiceText = (choice: AiDefaultChoice | null) => (choice === null ? null : formatAiDefaultChoice(choice));

/**
 * Store the organization's choice, or clear it (`null`: the shipped order
 * decides). The provider goes to `ai_default`; a model with it becomes
 * that provider's chat model setting in `ai_models` (without one, the
 * provider's models stay as they are). Refuses a choice the default can't
 * be (AI_DEFAULT_INVALID: an id the catalog doesn't have, an API
 * provider, an entry without a chat route, AI Gateway) before anything is
 * written; accepts a provider whose key isn't set (the caller warns). In
 * the write's own batch: the `org_settings` upsert (the cap columns
 * untouched; the row deleted only when it holds nothing else) and
 * `ai.default_changed` when the choice changed.
 */
export async function setAiDefault(ws: Workspace, choice: AiDefaultChoice | null): Promise<AiDefaultChange> {
  if (choice) {
    const problem =
      aiDefaultChoiceProblem(choice) ?? (choice.model ? aiModelPatchProblem(choice.provider, { chat: choice.model }) : null);
    if (problem) {
      throw new EveryAppError("AI_DEFAULT_INVALID", `${choice.provider} can't be the default model provider: ${problem}`, {
        fix: `pick one of the providers ${CLI} ai list shows, as <provider> or <provider>/<model>`,
      });
    }
  }
  await requireAiModels(ws.db);
  const org = ws.organization.id;
  const stored = await readAi(ws.db, org);
  const next: StoredAi =
    choice === null
      ? { provider: null, models: stored.models }
      : {
          provider: choice.provider,
          models: choice.model ? withAiModelSetting(stored.models, choice.provider, { chat: choice.model }) : stored.models,
        };
  const was = choiceOf(stored);
  const now = choiceOf(next);
  const changed = choiceText(was) !== choiceText(now);
  const event = changed
    ? await queueEventFromCli(ws.db, {
        organizationId: org,
        type: "ai.default_changed",
        actor: operatorActor(ws.operator),
        data: { aiDefault: eventChoice(now), previous: eventChoice(was) },
        now: ws.now,
      })
    : [];
  await ws.db.run([...(await writeAi(ws, next)), ...event]);
  return { choice: now, was, changed };
}

/** What `setAiModels` answers: the provider's settings now and before, and whether they changed. */
interface AiModelChange {
  provider: string;
  models: { chat: string | null; embeddings: string | null };
  previous: { chat: string | null; embeddings: string | null };
  changed: boolean;
}

/**
 * Set or reset one provider's default models: a name stores it, null puts
 * the catalog's seed back, a field left out stays. Refuses a provider the
 * default can't be and an embeddings model on a provider without
 * embeddings (AI_DEFAULT_INVALID). In the write's own batch: the upsert
 * and `ai.model_changed` when a model changed.
 */
export async function setAiModels(ws: Workspace, provider: string, patch: AiModelPatch): Promise<AiModelChange> {
  const problem = aiModelPatchProblem(provider, patch);
  if (problem) {
    throw new EveryAppError("AI_DEFAULT_INVALID", `Can't set ${provider}'s models: ${problem}`, {
      fix: `pick one of the providers ${CLI} ai list shows`,
    });
  }
  await requireAiModels(ws.db);
  const org = ws.organization.id;
  const stored = await readAi(ws.db, org);
  const next: StoredAi = { provider: stored.provider, models: withAiModelSetting(stored.models, provider, patch) };
  const before = stored.models[provider] ?? {};
  const after = next.models[provider] ?? {};
  const models = { chat: after.chat ?? null, embeddings: after.embeddings ?? null };
  const previous = { chat: before.chat ?? null, embeddings: before.embeddings ?? null };
  const changed = models.chat !== previous.chat || models.embeddings !== previous.embeddings;
  const event = changed
    ? await queueEventFromCli(ws.db, {
        organizationId: org,
        type: "ai.model_changed",
        actor: operatorActor(ws.operator),
        data: { provider, models, previous },
        now: ws.now,
      })
    : [];
  await ws.db.run([...(await writeAi(ws, next)), ...event]);
  return { provider, models, previous, changed };
}

/** What `ai show` reports: the resolution on this Gateway, and whether AI Gateway is in front. */
export interface AiReport {
  resolution: AiDefaultResolution;
  /** The Gateway's secret names (what `isSet` read), sorted. */
  names: string[];
  aiGateway: { on: boolean };
}

/**
 * The default as it resolves on this Gateway now: the stored provider and
 * models and the Gateway Worker's secret names (a name present counts as set; values
 * are never read). AI Gateway is "on" when its id and the account are set.
 */
export async function aiReport(cf: CfRunner, ws: Workspace): Promise<AiReport> {
  const [names, stored] = await Promise.all([listGatewaySecretNames(cf), readAi(ws.db, ws.organization.id)]);
  const isSet = (name: string) => names.includes(name);
  const resolution = resolveAiDefault({ ...stored, isSet });
  return { resolution, names, aiGateway: { on: AI_GATEWAY_SETTINGS.every(isSet) } };
}

/** `ai default <provider>[/<model>]` as typed, or `off`; anything else is refused before connecting. */
export function parseAiDefaultArgument(input: string): AiDefaultChoice | null {
  const value = input.trim();
  if (value === "off" || value === "none") return null;
  const choice = parseAiDefaultChoice(value);
  if (!choice) {
    throw new EveryAppError(
      "AI_DEFAULT_INVALID",
      `${input} isn't a provider: write the provider's id (openrouter), or the id and a model (openrouter/anthropic/claude-haiku-5.5), or off`,
      { fix: `${CLI} ai list names the providers the default can be` },
    );
  }
  return choice;
}
