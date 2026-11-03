/**
 * `everyapp ai …`: the workspace's default model from the terminal
 * (docs/design/2026-10-model-providers.md), read and written in the
 * Gateway's D1 under the operator's Cloudflare login like every workspace
 * change (ADR-0003): one setting, `org_settings.ai_default` =
 * `<provider>[/<model>]`, on the install organization, as Manage
 * workspace → Usage → AI default and the `everyapp_ai_*` tools write it
 * for a signed-in admin (AiDefaultService in the Worker). The rule that
 * turns it and the Gateway's settings into the provider and model that
 * serve is the SDK's (`resolveAiDefault`: the setting, else the first
 * provider of the order whose key is set; the provider's seed where the
 * setting names no model), run here on the Gateway Worker's secret names
 * (never values) and by the Gateway on its env.
 *
 * `setAiDefault` queues `ai.default_changed` in the batch that writes the
 * row, only when the setting changed, and never deletes a row that still
 * holds a cap (the defaults share `org_settings`).
 */
import {
  aiDefaultChoiceProblem,
  type CapabilityLookup,
  formatAiDefaultChoice,
  parseAiDefaultChoice,
  resolveAiDefault,
  AI_GATEWAY_SETTINGS,
  type AiDefaultChoice,
  type AiDefaultResolution,
} from "@every-app/sdk/internal";
import type { GatewayNames } from "@every-app/perimeter/manifest";
import type { D1Database } from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { listGatewaySecretNames } from "@/lib/app/settings";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { EMPTY_ORG_SETTINGS_SQL } from "./costCaps";
import { operatorActor, queueEventFromCli } from "./events";
import type { Workspace } from "./workspace";

/** The organization's setting, or null. */
async function readAiDefault(db: D1Database, organizationId: string): Promise<AiDefaultChoice | null> {
  const [rows = []] = await db.run([
    {
      sql: "SELECT ai_default FROM org_settings WHERE organization_id = ?",
      params: [organizationId],
    },
  ]);
  const value = rows[0]?.["ai_default"];
  return parseAiDefaultChoice(typeof value === "string" ? value : null);
}

/** What `setAiDefault` answers: the setting now, the setting before, and whether the write changed it. */
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
 * Store the workspace's default model, or clear it (`null`: the shipped
 * order decides). Refuses a choice the default can't be
 * (AI_DEFAULT_INVALID: an id the catalog doesn't have, an API provider,
 * an entry without a chat route, AI Gateway, a model that isn't a model
 * id) before anything is written; accepts a provider whose key isn't set
 * (the caller warns). In the write's own batch: the `org_settings` upsert
 * (the cap columns untouched; the row deleted only when it holds nothing
 * else) and `ai.default_changed` when the setting changed.
 */
export async function setAiDefault(
  ws: Workspace,
  choice: AiDefaultChoice | null,
  /** The Gateway's registry (a registered `ai` row may be the default); the catalog alone when absent. */
  lookup?: CapabilityLookup,
): Promise<AiDefaultChange> {
  if (choice) {
    const problem = aiDefaultChoiceProblem(choice, lookup);
    if (problem) {
      throw new EveryAppError("AI_DEFAULT_INVALID", `${choice.provider} can't be the default model provider: ${problem}`, {
        fix: `pick one of the providers ${CLI} ai show lists, as <provider> or <provider>/<model>`,
      });
    }
  }
  const org = ws.organization.id;
  const was = await readAiDefault(ws.db, org);
  const changed = choiceText(was) !== choiceText(choice);
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
      params: [org, choiceText(choice), ws.now, ws.operator.userId],
    },
    // A row with no default of any kind needs no row.
    { sql: `DELETE FROM org_settings WHERE organization_id = ? AND ${EMPTY_ORG_SETTINGS_SQL}`, params: [org] },
    ...event,
  ]);
  return { choice, was, changed };
}

/** What `ai show` reports: the resolution on this Gateway, and whether AI Gateway is in front. */
export interface AiReport {
  resolution: AiDefaultResolution;
  /** The stored setting as text, or null. */
  choice: string | null;
  /** The Gateway's secret names (what `isSet` read), sorted. */
  names: string[];
  aiGateway: { on: boolean };
}

/**
 * The default as it resolves on this Gateway now: the stored setting and
 * the Gateway Worker's secret names (a name present counts as set; values
 * are never read). AI Gateway is "on" when its id and the account are set.
 */
export async function aiReport(
  cf: CfRunner,
  gateway: Pick<GatewayNames, "worker">,
  ws: Workspace,
  lookup?: CapabilityLookup,
): Promise<AiReport> {
  const [names, choice] = await Promise.all([listGatewaySecretNames(cf, gateway), readAiDefault(ws.db, ws.organization.id)]);
  const isSet = (name: string) => names.includes(name);
  const resolution = resolveAiDefault({ choice, isSet, ...(lookup ? { lookup } : {}) });
  return { resolution, choice: choiceText(choice), names, aiGateway: { on: AI_GATEWAY_SETTINGS.every(isSet) } };
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
      { fix: `${CLI} ai show lists the providers the default can be` },
    );
  }
  return choice;
}
