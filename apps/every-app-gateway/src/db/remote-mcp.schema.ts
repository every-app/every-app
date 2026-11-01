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
 * Which origin a remote MCP app's credential was set for
 * (docs/design/2026-10-mcp-by-url.md, "The credential and where it is
 * pinned"). `everyapp secret set <NAME>_MCP_TOKEN` records the origin of the
 * row that declares the name; a gateway that finds a set credential with
 * no row here binds it to the row's origin on first use. The gateway sends
 * a credential only to the origin bound here, so an owner or admin who
 * re-points a row, or removes one and adds another under the same id,
 * never makes it go anywhere the operator didn't set it for. One row per
 * credential name; the install has one set of Gateway secrets, so the
 * table is not per organization. `everyapp secret unset` deletes the row.
 */
export const remoteMcpCredentials = sqliteTable("remote_mcp_credentials", {
  // The Gateway setting's name (`TREG_MCP_TOKEN`).
  name: text("name").primaryKey(),
  // The origin (`https://treg.to`) the credential may be sent to.
  origin: text("origin").notNull(),
  // The Cloudflare login that set it, or "gateway" for a first-use binding.
  boundBy: text("bound_by"),
  boundAt: integer("bound_at", { mode: "timestamp_ms" }).notNull(),
});

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
