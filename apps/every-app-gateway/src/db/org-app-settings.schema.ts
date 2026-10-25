import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";
import { apps } from "./apps.schema";

/**
 * What an organization decided about one app it can call: a monthly cap on
 * the app's provider calls (AI providers and capabilities counted in
 * `usage_monthly`), or that the app has none even though the organization
 * set a default for every app (`org_settings.default_monthly_call_cap`).
 * No row: the default applies, and without one the app is unlimited. One
 * row per (organization, app row); a shared app's row belongs to the
 * platform organization, so every organization caps it on its own. The row
 * goes with the organization or the app.
 *
 * Row invariant, kept by every writer (the gateway's upsert here, the CLI's
 * raw SQL): exactly one of (`monthly_call_cap` set, `unlimited` false) or
 * (`monthly_call_cap` null, `unlimited` true); a write sets both columns in
 * one statement. The reader lets a cap win: a row with both keeps the app
 * capped, which fails safe; a row with neither (from before `unlimited`
 * existed) falls through to the default.
 */
export const orgAppSettings = sqliteTable(
  "org_app_settings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appRowId: text("app_row_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    // Provider calls allowed per UTC month; null with `unlimited` false
    // means the default applies.
    monthlyCallCap: integer("monthly_call_cap"),
    // This app has no cap, whatever the organization's default.
    unlimited: integer("unlimited", { mode: "boolean" })
      .notNull()
      .default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    // The owner or admin who last set it (null once their user row is gone,
    // and from the CLI, which is not a gateway user).
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.appRowId] })],
);
