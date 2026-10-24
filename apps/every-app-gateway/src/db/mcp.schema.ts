import {
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps.schema";
import { organizations, users } from "./auth.schema";

/**
 * The tools catalog each app last reported (one row per app). MCP clients
 * are served from this snapshot, never by asking apps live: one request may
 * make at most 32 Worker invocations, and a slow app must not slow every
 * tools/list. The gateway takes it when an app is activated or deployed
 * through it, when the app's `version_id` moves on from the one it was
 * taken from, when the consent page or /mcp finds none, and when a tool
 * call reports a different `catalog_hash`.
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
    // The app's `apps.version_id` the snapshot was taken from (for one that
    // isn't serving, the last one tried). A snapshot from another version is
    // re-taken on use.
    versionId: text("version_id"),
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

/**
 * One row per consent to an OAuth client (an AI app such as Claude) at the
 * gateway's /mcp. Tokens carry only ids; every /mcp request re-reads this row
 * (and the member's live membership), so revoking it takes effect on the
 * next request, as would narrowing its apps: no new token is needed.
 */
export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    // "mcpc_" + 32 hex characters.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    // The client's own name: verified only when client_domain is set.
    clientName: text("client_name").notNull(),
    // A Client ID Metadata Document client's domain; null for DCR clients.
    clientDomain: text("client_domain"),
    redirectUri: text("redirect_uri").notNull(),
    redirectHost: text("redirect_host").notNull(),
    // "all" (every app the user can use, including future ones) | "selected"
    appScope: text("app_scope").notNull(),
    // "read" | "write"
    access: text("access").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by"),
    // "user" | "superseded" | "member_removed" | "user_deactivated" |
    // "expired" | "ended" (the client revoked its grant) | "failed"
    revokedReason: text("revoked_reason"),
  },
  (table) => [
    index("mcp_connections_user_org_idx").on(
      table.userId,
      table.organizationId,
    ),
    index("mcp_connections_user_client_idx").on(table.userId, table.clientId),
    index("mcp_connections_organization_id_idx").on(table.organizationId),
  ],
);

/** The apps a connection with app_scope "selected" may use. */
export const mcpConnectionApps = sqliteTable(
  "mcp_connection_apps",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    appRowId: text("app_row_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.appRowId] }),
    index("mcp_connection_apps_app_row_id_idx").on(table.appRowId),
  ],
);

/**
 * One row per MCP tools/call, allowed or refused, on either surface. Never
 * the arguments or the result: a keyed digest of the arguments and the
 * result's size. No foreign keys, so the trail outlives the user, app or
 * connection; an hourly cron deletes rows past the retention window.
 */
export const mcpToolCalls = sqliteTable(
  "mcp_tool_calls",
  {
    // The call id the app also received.
    id: text("id").primaryKey(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    // "oauth" | "pat" | "session"
    credentialKind: text("credential_kind").notNull(),
    // The connection or PAT id ("session" for a browser session).
    credentialId: text("credential_id").notNull(),
    clientName: text("client_name"),
    // The client's own description from the MCP handshake, "<name>
    // <version>" (at most 200 characters): the 2026-07-28 per-request
    // clientInfo, or the 2025 initialize one carried in the session id.
    // Self-asserted, never verified; null when the client sent none.
    clientInfo: text("client_info"),
    // "gateway" | "app"
    surface: text("surface").notNull(),
    appRowId: text("app_row_id"),
    appSlug: text("app_slug"),
    // The name the client called, cut to 128 characters. For a call made
    // through a wrapper built-in, the inner tool's name (see `via`).
    toolName: text("tool_name").notNull(),
    // The wrapper built-in the call came through ("everyapp_call_read" or
    // "everyapp_call_write"), when it did: `tool_name` is then the inner
    // tool, and this is the row's only trace of the wrapper. Null for a
    // call made by name.
    via: text("via"),
    risk: text("risk"),
    // "allowed" | "blocked"
    decision: text("decision").notNull(),
    reason: text("reason"),
    outcome: text("outcome").notNull(),
    durationMs: integer("duration_ms"),
    argsDigest: text("args_digest"),
    resultBytes: integer("result_bytes"),
    protocolVersion: text("protocol_version"),
    requestId: text("request_id"),
  },
  (table) => [
    index("mcp_tool_calls_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("mcp_tool_calls_credential_created_idx").on(
      table.credentialId,
      table.createdAt,
    ),
    index("mcp_tool_calls_created_idx").on(table.createdAt),
  ],
);
