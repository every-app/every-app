import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./auth.schema";

/**
 * Each organization's key: up to 12 of `[a-z0-9]`, taken from its slug the
 * first time it registers an app and never changed after, even when the slug
 * is. App Worker and resource names are `every-<orgKey>-<appId>`, so two
 * organizations never share a Worker, D1 database or KV namespace.
 */
export const organizationKeys = sqliteTable("organization_keys", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  orgKey: text("org_key").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
});
