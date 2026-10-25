import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";

/**
 * What an organization decided for every app it can call: a default
 * monthly cap on provider calls, which binds each app without a row of its
 * own in `org_app_settings` (or with a row that says neither cap nor
 * unlimited), and the default model provider. Null, or no row, is no
 * default. One row per organization, gone with it.
 */
export const orgSettings = sqliteTable("org_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  defaultMonthlyCallCap: integer("default_monthly_call_cap"),
  // The default model provider, `<provider>[/<model>]` as `everyapp ai
  // default` stores it (the SDK's parseAiDefaultChoice); null leaves the
  // shipped order to decide (docs/design/2026-10-model-providers.md).
  aiDefault: text("ai_default"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // The owner or admin who last set it (null once their user row is gone,
  // and from the CLI, which is not a gateway user).
  updatedBy: text("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
});
