/**
 * Usage reports at `setup` and `update` (https://everyapp.com/docs/telemetry).
 * The CLI sends nothing itself. Here it does two things for the Gateway's
 * daily report, in the Gateway's own D1 row (`telemetry_state`):
 *
 *  - leaves reports off before the Gateway ever sends one, when the person
 *    asked: `setup --no-telemetry`, or DO_NOT_TRACK in the shell that runs
 *    `setup` or `update`;
 *  - otherwise reads when the first report goes, so the run can say so
 *    before it does: a day after setup, or the notice period after the
 *    update that brought reports to a Gateway that already existed.
 *
 * The policy and the words are the SDK's (`@every-app/sdk/internal`
 * telemetry.ts), shared with the Gateway's admin page.
 */
import { doNotTrack, usageReportNotice, usageReportSchedule, type UsageReportChoice } from "@every-app/sdk/internal";
import type { D1Database } from "@/lib/cf/d1";

/** Why this run left reports off. */
type OffBecause = "no-telemetry" | "do-not-track";

/** What the run says about usage reports; null when there is nothing to say. */
export type UsageReportsAtSetup =
  | { usageReports: "on"; startsAt: string; notice: { headline: string; detail: string } }
  | { usageReports: "off"; because: OffBecause }
  | null;

async function readChoice(db: D1Database): Promise<UsageReportChoice | null> {
  // A release from before usage reports has no such table.
  const [tables = []] = await db.run([{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telemetry_state'" }]);
  if (tables.length === 0) return null;
  const [rows = []] = await db.run([{ sql: "SELECT existing, created_at, enabled, changed_at FROM telemetry_state WHERE id = 'telemetry'" }]);
  const row = rows[0];
  if (!row) return null;
  const enabled = row["enabled"];
  return {
    existing: Number(row["existing"]) === 1,
    createdAt: Number(row["created_at"]),
    enabled: enabled === null || enabled === undefined ? null : Number(enabled) === 1,
    changedAt: row["changed_at"] === null || row["changed_at"] === undefined ? null : Number(row["changed_at"]),
  };
}

/** Turn reports off in the Gateway's row, as its own switch does: the random id goes too. */
async function turnOff(db: D1Database, because: OffBecause, now: number): Promise<void> {
  await db.run([
    {
      sql: "UPDATE telemetry_state SET enabled = 0, changed_at = ?1, changed_by = ?2, install_id = NULL, last_payload = NULL WHERE id = 'telemetry'",
      params: [now, `cli:${because}`],
    },
  ]);
}

/**
 * After the Gateway is deployed and migrated: leave reports off if the
 * person asked, else say when the first one goes.
 *
 * `--no-telemetry` always turns them off. DO_NOT_TRACK turns them off
 * unless someone turned them on at the Gateway since: that choice was
 * made on purpose, by an owner or admin. Nothing is said about a Gateway
 * that can't send (`published` false: a build from a checkout, a fork, a
 * file) unless this run turned reports off.
 */
export async function usageReportsAtSetup(options: {
  db: D1Database;
  /** `setup --no-telemetry`. */
  noTelemetry: boolean;
  /** The release is one Every App published: the only kind that sends. */
  published: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
}): Promise<UsageReportsAtSetup> {
  const now = options.now ?? Date.now();
  const choice = await readChoice(options.db);
  if (!choice) return null;
  const because: OffBecause | null = options.noTelemetry ? "no-telemetry" : doNotTrack(options.env ?? process.env) && choice.enabled === null ? "do-not-track" : null;
  if (because) {
    if (choice.enabled !== false) await turnOff(options.db, because, now);
    return { usageReports: "off", because };
  }
  if (!options.published) return null;
  const notice = usageReportNotice(choice, now);
  const { startsAt } = usageReportSchedule(choice);
  if (!notice || startsAt === null) return null;
  return { usageReports: "on", startsAt: new Date(startsAt).toISOString(), notice };
}
