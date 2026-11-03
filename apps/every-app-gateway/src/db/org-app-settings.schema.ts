import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";
import { apps } from "./apps.schema";

/**
 * What an organization decided about one app it can call: a monthly cap in
 * dollars on the cost the providers report for its calls (counted in
 * `usage_monthly.cost_micros`), or that the app has none even though the
 * organization set a default for every app (`org_settings`). No row: the
 * default applies, and without one the app is unlimited. One row per
 * (organization, app row); a shared app's row belongs to the platform
 * organization, so every organization caps it on its own. The row goes
 * with the organization or the app.
 *
 * Row invariant, kept by every writer (the gateway's upsert here, the CLI's
 * raw SQL): either a cap with `unlimited` false, or no cap with `unlimited`
 * true; a write sets every column in one statement. The reader lets a cap
 * win: a row with both keeps the app capped, which fails safe.
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
    // Provider-reported cost allowed per UTC month, in millionths of a US
    // dollar (as `usage_monthly.cost_micros` counts it); null with
    // `unlimited` false means the default applies. Only OpenRouter and
    // DataForSEO report a cost today, so only their calls move toward it.
    monthlyCostCapMicros: integer("monthly_cost_cap_micros"),
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
