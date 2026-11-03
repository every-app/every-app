import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
