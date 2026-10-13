import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps.schema";

/**
 * The tools catalog each app last reported (one row per app). MCP clients
 * are served from this snapshot, never by asking apps live: one request may
 * make at most 32 Worker invocations, and a slow app must not slow every
 * tools/list. `everyapp app deploy` syncs it, and a tool call that reports a
 * different `catalog_hash` re-syncs it.
 */
export const appToolCatalogs = sqliteTable(
  "app_tool_catalogs",
  {
    appRowId: text("app_row_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    // "ok" (serving tools) | "empty" | "unsupported" (SDK < 0.3) | "error"
    status: text("status").notNull(),
    catalogHash: text("catalog_hash"),
    toolCount: integer("tool_count").notNull().default(0),
    instructions: text("instructions"),
    sdkVersion: text("sdk_version"),
    // JSON string[]: tools skipped or trimmed at the last sync.
    warnings: text("warnings"),
    lastError: text("last_error"),
    // When the snapshot was taken. For a catalog that isn't serving (empty,
    // unsupported, error), when the gateway last tried to take one.
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "app_tool_catalogs_app_row_org_fk",
    }).onDelete("cascade"),
  ],
);

/** One row per tool in an app's current catalog, replaced on every sync. */
export const appTools = sqliteTable(
  "app_tools",
  {
    appRowId: text("app_row_id").notNull(),
    organizationId: text("organization_id").notNull(),
    // Local name, e.g. "create_todo".
    name: text("name").notNull(),
    title: text("title"),
    description: text("description").notNull(),
    // "read" | "write" | "destructive"
    risk: text("risk").notNull(),
    inputSchema: text("input_schema").notNull(),
    outputSchema: text("output_schema"),
    // JSON {idempotentHint?, openWorldHint?}
    annotations: text("annotations"),
    catalogHash: text("catalog_hash").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appRowId, table.name] }),
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "app_tools_app_row_org_fk",
    }).onDelete("cascade"),
    index("app_tools_organization_id_idx").on(table.organizationId),
  ],
);
