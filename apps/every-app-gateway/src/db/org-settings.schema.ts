import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations, users } from "./auth.schema";

/**
 * What an organization decided for every app it can call: a default
 * monthly cap on provider calls and one in dollars on provider-reported
 * cost, each binding every app without a cap of that kind of its own in
 * `org_app_settings` (and not `unlimited`), the default model provider,
 * and the linked dev switch. Null, or no row, is no default. One row per organization,
 * gone with it; a write of one default keeps the others, and the row goes
 * only when it holds none.
 */
export const orgSettings = sqliteTable("org_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  defaultMonthlyCallCap: integer("default_monthly_call_cap"),
  // Millionths of a US dollar of provider-reported cost per UTC month.
  defaultMonthlyCostCapMicros: integer("default_monthly_cost_cap_micros"),
  // The default model provider's id as `everyapp ai default` stores it
  // (the SDK's parseAiDefaultProvider); null leaves the shipped order to
  // decide (docs/design/2026-10-model-providers.md).
  aiDefault: text("ai_default"),
  // The operator's default models by provider, JSON `{ "<provider>":
  // { "chat"?, "embeddings"? } }` as `everyapp ai model` stores it (the
  // SDK's parseAiModelSettings); a provider or field left out serves the
  // catalog's seed. Null: every provider serves its seeds.
  aiModels: text("ai_models"),
  // Linked dev (docs/design/linked-dev.md): whether owners and admins may
  // sign `everyapp dev --gateway` in to this organization's apps, so a
  // local app reaches the Gateway's providers and services. Off unless an
  // owner or admin turned it on (`everyapp workspace linked-dev on`).
  linkedDev: integer("linked_dev", { mode: "boolean" })
    .notNull()
    .default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // The owner or admin who last set it (null once their user row is gone,
  // and from the CLI, which is not a gateway user).
  updatedBy: text("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),
});
