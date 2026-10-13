import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Counters for budgets that must hold across isolates and locations, which
 * an isolate's memory or a per-location rate limiter can't keep: one row
 * per key and window, e.g. "oauth-register:gateway:2026-10-13". A request
 * reads its few rows by key and only a request that is let through writes,
 * so a flood of refused requests costs reads, never writes. The hourly
 * maintenance deletes expired rows.
 */
export const rateLimitCounters = sqliteTable(
  "rate_limit_counters",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    // When the window ends and the row can go.
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("rate_limit_counters_expires_at_idx").on(table.expiresAt)],
);
