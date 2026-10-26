import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * The API providers one gateway registered beyond the built-in catalog
 * (`everyapp provider add`; docs/design/2026-10-provider-registry.md): one
 * row per provider id, its spec as JSON, who added it and when. The CLI
 * writes the rows straight into D1 in self-host (ADR-0003), with the rules
 * in `@every-app/sdk/internal` (providerRegistry.ts); the gateway re-parses
 * and re-checks every row on read and serves none that fails. The key a
 * row names is a Gateway setting, never a column here.
 */
export const providers = sqliteTable("providers", {
  // The provider id (`stripe`): the capability id apps list.
  id: text("id").primaryKey(),
  // The spec as `everyapp provider add` took it, JSON text.
  spec: text("spec").notNull(),
  // The Cloudflare login's email (or `api-token:<account id>`), or a member's email through the MCP tool.
  addedBy: text("added_by"),
  addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // What the row's key was set for (`providerBindingKey`: its hosts, host
  // setting and auth as one canonical string), written by `everyapp secret
  // set`; the gateway reads the key only while the row still matches. Null
  // until a key is set.
  boundTo: text("bound_to"),
  boundAt: integer("bound_at", { mode: "timestamp_ms" }),
});

/**
 * Scope sets an operator added to a built-in OAuth client
 * (`everyapp provider scope-set add google-workspace gmail-send.json`,
 * Admin → Providers → Scope sets, `everyapp_provider_scope_set_add`): one
 * row per client and set name, the set's spec as JSON (its label, access,
 * scopes and the routes on the client's API hosts it unlocks), who added
 * it and when. The gateway re-parses and re-checks every row on read
 * against the client's catalog entry (`resolveScopeSetRow` in
 * `@every-app/sdk/internal`) and serves none that fails. A row never
 * replaces one of the client's own sets.
 */
export const providerScopeSets = sqliteTable(
  "provider_scope_sets",
  {
    // The built-in OAuth client (`google-workspace`).
    providerId: text("provider_id").notNull(),
    // The set's name, what an app lists under `scopes` (`gmail.send`).
    name: text("name").notNull(),
    // The set's spec as the command took it, JSON text.
    spec: text("spec").notNull(),
    addedBy: text("added_by"),
    addedAt: integer("added_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.name] })],
);
