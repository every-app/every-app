/**
 * `everyapp ai …`: the Gateway's default model provider from the terminal
 * (docs/design/2026-10-model-providers.md), read and written in the
 * Gateway's D1 under the operator's Cloudflare login like every workspace
 * change (ADR-0003): `org_settings.ai_default` on the install
 * organization, as Manage workspace → Usage → AI default writes it for a
 * signed-in admin (AiDefaultService in the Worker). The rule that turns
 * the stored choice and the Gateway's settings into the provider that
 * serves is the SDK's (`resolveAiDefault`), run here on the Gateway
 * Worker's secret names (never values) and by the Gateway on its env.
 *
 * `setAiDefault` queues `ai.default_changed` in the batch that writes the
 * row, only when the choice changed, and never deletes a row that still
 * holds the default cap (the two share `org_settings`). A Gateway from
 * before migration 0017 has no `ai_default` column: `ai default` refuses
 * with the command that brings it up to date; `ai show` reads it as no
 * choice.
 */
import {
  aiDefaultChoiceProblem,
  formatAiDefaultChoice,
  parseAiDefaultChoice,
  resolveAiDefault,
  AI_GATEWAY_SETTINGS,
  type AiDefaultChoice,
  type AiDefaultResolution,
} from "@every-app/sdk/internal";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { listGatewaySecretNames } from "@/lib/app/settings";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { operatorActor, queueEventFromCli } from "./events";
import type { Workspace } from "./workspace";

const aiDefaultColumns = new WeakMap<D1Database, Promise<boolean>>();

/** Whether the Gateway's `org_settings` has `ai_default` (migration 0017, 2026-10-25). Asked of each database once. */
export function hasAiDefault(db: D1Database): Promise<boolean> {
  let known = aiDefaultColumns.get(db);
  if (!known) {
    known = db
      .run([{ sql: "PRAGMA table_info(org_settings)" }])
      .then(([rows = []]) => rows.some((row) => row["name"] === "ai_default"));
    aiDefaultColumns.set(db, known);
  }
  return known;
}

/** Refuse a write on a Gateway from before the column. */
async function requireAiDefault(db: D1Database): Promise<void> {
  if (await hasAiDefault(db)) return;
  throw new EveryAppError(
    "GATEWAY_PREDATES_AI_DEFAULT",
    "The Gateway predates the default model provider\nIts database has no ai_default column until the Gateway is updated to a release that has it.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

/** The organization's stored choice, or null (also on a Gateway without the column). */
async function readAiDefault(db: D1Database, organizationId: string): Promise<AiDefaultChoice | null> {
  if (!(await hasAiDefault(db))) return null;
  const [rows = []] = await db.run([
    { sql: "SELECT ai_default FROM org_settings WHERE organization_id = ?", params: [organizationId] },
  ]);
  const value = rows[0]?.["ai_default"];
  return parseAiDefaultChoice(typeof value === "string" ? value : null);
}

/** What `setAiDefault` answers: the choice now, the choice before, and whether the write changed it. */
interface AiDefaultChange {
  choice: AiDefaultChoice | null;
  was: AiDefaultChoice | null;
  changed: boolean;
}

/** The choice as the event carries it: provider and model, model null when the entry's is used. */
const eventChoice = (choice: AiDefaultChoice | null) =>
  choice === null ? null : { provider: choice.provider, model: choice.model ?? null };

/**
 * Store the organization's choice, or clear it (`null`: the shipped order
 * decides). Refuses a choice the default can't be (AI_DEFAULT_INVALID:
 * an id the catalog doesn't have, an API provider, an entry without a
 * chat route, AI Gateway) before anything is written; accepts a provider
 * whose key isn't set (the caller warns). In the write's own batch: the
 * `org_settings` upsert (the cap column untouched; the row deleted only
 * when it holds nothing else) and `ai.default_changed` when the choice
 * changed.
 */
export async function setAiDefault(ws: Workspace, choice: AiDefaultChoice | null): Promise<AiDefaultChange> {
  if (choice) {
    const problem = aiDefaultChoiceProblem(choice);
    if (problem) {
      throw new EveryAppError("AI_DEFAULT_INVALID", `${choice.provider} can't be the default model provider: ${problem}`, {
        fix: `pick one of the providers ${CLI} ai list shows, as <provider> or <provider>/<model>`,
      });
    }
  }
  await requireAiDefault(ws.db);
  const org = ws.organization.id;
  const was = await readAiDefault(ws.db, org);
  const stored = choice === null ? null : formatAiDefaultChoice(choice);
  const changed = (was === null ? null : formatAiDefaultChoice(was)) !== stored;
  const event = changed
    ? await queueEventFromCli(ws.db, {
        organizationId: org,
        type: "ai.default_changed",
        actor: operatorActor(ws.operator),
        data: { aiDefault: eventChoice(choice), previous: eventChoice(was) },
        now: ws.now,
      })
    : [];
  await ws.db.run([
    {
      sql: `INSERT INTO org_settings (organization_id, ai_default, updated_at, updated_by)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT (organization_id) DO UPDATE SET ai_default = ?2, updated_at = ?3, updated_by = ?4`,
      params: [org, stored, ws.now, ws.operator.userId],
    },
    // A row with no default of either kind needs no row.
    {
      sql: "DELETE FROM org_settings WHERE organization_id = ? AND ai_default IS NULL AND default_monthly_call_cap IS NULL",
      params: [org],
    },
    ...event,
  ]);
  return { choice, was, changed };
}

/** What `ai show` reports: the resolution on this Gateway, and whether AI Gateway is in front. */
export interface AiReport {
  resolution: AiDefaultResolution;
  /** The Gateway's secret names (what `isSet` read), sorted. */
  names: string[];
  aiGateway: { on: boolean };
}

/**
 * The default as it resolves on this Gateway now: the stored choice and
 * the Gateway Worker's secret names (a name present counts as set; values
 * are never read). AI Gateway is "on" when its id and the account are set.
 */
export async function aiReport(cf: CfRunner, ws: Workspace): Promise<AiReport> {
  const [names, choice] = await Promise.all([listGatewaySecretNames(cf), readAiDefault(ws.db, ws.organization.id)]);
  const isSet = (name: string) => names.includes(name);
  const resolution = resolveAiDefault({ choice, isSet });
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
