/**
 * The dollar caps' columns (migration 0018, `cost_caps`, 2026-10-25):
 * `org_app_settings.monthly_cost_cap_micros` and
 * `org_settings.default_monthly_cost_cap_micros`, whole millionths of a US
 * dollar of provider-reported cost per UTC month. A Gateway from before
 * them has neither until `update` runs its migrations; a write of a
 * dollar cap is refused there (GATEWAY_PREDATES_COST_CAPS), a read takes
 * them as none. Shared by `workspace app cap|cap default` and `ai default`,
 * which both write `org_settings` and must keep the columns they don't name.
 */
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";

/** A dollar cap is a cent to a million dollars, in whole cents (AppCapService). */
export const MONTHLY_COST_CAP_MIN_USD = 0.01;
export const MONTHLY_COST_CAP_MAX_USD = 1_000_000;

const costCapColumns = new WeakMap<D1Database, Promise<boolean>>();

/** Whether the Gateway's D1 has both dollar cap columns. Asked of each database once. */
export function hasCostCaps(db: D1Database): Promise<boolean> {
  let known = costCapColumns.get(db);
  if (!known) {
    known = db
      .run([{ sql: "PRAGMA table_info(org_app_settings)" }, { sql: "PRAGMA table_info(org_settings)" }])
      .then(
        ([appSettings = [], settings = []]) =>
          appSettings.some((row) => row["name"] === "monthly_cost_cap_micros") &&
          settings.some((row) => row["name"] === "default_monthly_cost_cap_micros"),
      );
    costCapColumns.set(db, known);
  }
  return known;
}

/** Refuse a dollar cap on a Gateway from before the columns. */
export async function requireCostCaps(db: D1Database): Promise<void> {
  if (await hasCostCaps(db)) return;
  throw new EveryAppError(
    "GATEWAY_PREDATES_COST_CAPS",
    "The Gateway predates dollar caps\nIts database has no monthly cap in dollars until the Gateway is updated to a release that has it.",
    { rerun: `${CLI} update`, rerunNote: "then run this again" },
  );
}

/**
 * A dollar cap as stored: whole cents to micro-dollars, null for off,
 * undefined left as it is. Out of range or finer than a cent: INVALID_CAP.
 */
export function costCapMicros(usd: number | null | undefined): number | null | undefined {
  if (usd === null || usd === undefined) return usd;
  const cents = Math.round(usd * 100);
  if (
    !Number.isFinite(usd) ||
    Math.abs(usd * 100 - cents) > 1e-6 ||
    usd < MONTHLY_COST_CAP_MIN_USD ||
    usd > MONTHLY_COST_CAP_MAX_USD
  ) {
    throw new EveryAppError(
      "INVALID_CAP",
      `A monthly dollar cap is from $${MONTHLY_COST_CAP_MIN_USD} to $${MONTHLY_COST_CAP_MAX_USD.toLocaleString("en-US")} in whole cents, or off`,
    );
  }
  return cents * 10_000;
}

/** Micro-dollars as the events carry dollars: a number with cents, or null. */
export const microsToUsd = (micros: number | null): number | null =>
  micros === null ? null : Math.round(micros / 10_000) / 100;

/**
 * SQL: the organization's `org_settings` row holds no default of any kind
 * this Gateway has (the call cap, the dollar cap, the model provider, the
 * models), so
 * the row can go. Every writer of the row ends its batch with a DELETE on
 * this condition rather than deleting outright.
 */
export function emptyOrgSettingsSql(columns: {
  cost: boolean;
  ai: boolean;
  models: boolean;
  /** The Gateway has `linked_dev` (migration 0022): a row with it on is not empty. */
  linkedDev?: boolean;
}): string {
  return [
    "default_monthly_call_cap IS NULL",
    ...(columns.cost ? ["default_monthly_cost_cap_micros IS NULL"] : []),
    ...(columns.ai ? ["ai_default IS NULL"] : []),
    ...(columns.models ? ["ai_models IS NULL"] : []),
    ...(columns.linkedDev ? ["linked_dev = 0"] : []),
  ].join(" AND ");
}
