import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const ownerBootstrap = sqliteTable(
  "owner_bootstrap",
  {
    id: text("id").primaryKey(),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    check("owner_bootstrap_singleton_check", sql`${table.id} = 'owner'`),
  ],
);
