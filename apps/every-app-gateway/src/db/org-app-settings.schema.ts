import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";
import { apps } from "./apps.schema";

/**
 * What an organization decided about one app it can call: today a monthly
 * cap on the app's provider calls (AI providers and capabilities counted in
 * `usage_monthly`), null for unlimited, which is the default and needs no
 * row. One row per (organization, app row); a shared app's row belongs to
 * the platform organization, so every organization caps it on its own.
 * The row goes with the organization or the app.
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
    // Provider calls allowed per UTC month; null is unlimited.
    monthlyCallCap: integer("monthly_call_cap"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    // The owner or admin who last set it (null once their user row is gone).
    updatedBy: text("updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.appRowId] })],
);
