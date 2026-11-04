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
 * What a remote MCP server listed, tool by tool, as the gateway last read
 * it (server/remote-mcp writes it at every listing, under the snapshot's
 * own write): the server's name for the tool, the ToolBus name it got
 * (null when it couldn't be normalized or collided with another's), what
 * its annotations said about risk, and whether it is in the catalog. The
 * catalog itself (`app_tools`) carries only ToolBus names and effective
 * risks, so this is what `everyapp mcp show`, the MCP app dialog and
 * `everyapp mcp tool` read to show a tool's source and to key an override
 * by the server's name. Goes with the app row.
 */
export const remoteMcpTools = sqliteTable(
  "remote_mcp_tools",
  {
    appRowId: text("app_row_id").notNull(),
    organizationId: text("organization_id").notNull(),
    // The server's own tool name.
    upstreamName: text("upstream_name").notNull(),
    // The ToolBus name (`get_user`), or null when not listable.
    localName: text("local_name"),
    title: text("title"),
    // What the server's annotations say alone: "read" | "write" |
    // "destructive" | "unknown" (no usable hint).
    riskHint: text("risk_hint").notNull(),
    // In the catalog: enabled, normalized, no collision.
    listed: integer("listed", { mode: "boolean" }).notNull(),
    // Why it isn't listed, in plain words.
    problem: text("problem"),
    listedAt: integer("listed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.appRowId, table.upstreamName] }),
    foreignKey({
      columns: [table.appRowId, table.organizationId],
      foreignColumns: [apps.id, apps.organizationId],
      name: "remote_mcp_tools_app_row_org_fk",
    }).onDelete("cascade"),
    index("remote_mcp_tools_organization_id_idx").on(table.organizationId),
  ],
);
