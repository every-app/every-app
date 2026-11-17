import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Usage reports (server/telemetry/): the one row that holds this Gateway's
 * choice and the reporter's own state. The migration writes the row, with
 * `existing` saying whether the Gateway already had an owner then; what
 * that means for when reports start is the policy in
 * `@every-app/sdk/internal` (telemetry.ts), not stored here.
 */
export const telemetryState = sqliteTable(
  "telemetry_state",
  {
    id: text("id").primaryKey(),
    /** The Gateway had an owner before usage reports existed. */
    existing: integer("existing", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** What someone chose: on or off; null while nobody has. */
    enabled: integer("enabled", { mode: "boolean" }),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }),
    /** Who chose: a user id, or `cli:<how>` for the CLI. */
    changedBy: text("changed_by"),
    /** Random, made for the first report and deleted when reports are turned off. */
    installId: text("install_id"),
    /** The last UTC day (YYYY-MM-DD) a report was sent for. */
    reportedDay: text("reported_day"),
    /** The day last tried, and how many tries it has had. */
    attemptDay: text("attempt_day"),
    attempts: integer("attempts").notNull().default(0),
    /** The last report sent, as it was sent. */
    lastPayload: text("last_payload"),
    lastReportedAt: integer("last_reported_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check("telemetry_state_singleton_check", sql`${table.id} = 'telemetry'`),
  ],
);
