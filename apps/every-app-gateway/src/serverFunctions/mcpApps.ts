/**
 * MCP apps from Admin → Apps (docs/design/2026-10-mcp-by-url.md, section
 * 4): add any remote MCP server by URL, change it, turn an MCP app of
 * either kind on or off, list its tools again, show it, and remove it.
 * Owners and admins, removing included (like deleting an app). The rules
 * and the writes are McpAppService's.
 */
import { createServerFn } from "@tanstack/react-start";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { McpAppService } from "@/server/services/McpAppService";
import {
  addRemoteMcpAppSchema,
  mcpAppIdSchema,
  setMcpAppStatusSchema,
  updateRemoteMcpAppSchema,
} from "@/schemas/mcpApp";

/**
 * Register a remote MCP server as an MCP app of this Gateway's. For a
 * server that takes no credential the answer says how many tools the
 * Gateway listed; for one that does, the command that sets it.
 */
export const addRemoteMcpApp = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => addRemoteMcpAppSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpAppService.add(context.org, data, context.user.email ?? null);
  });

/** Change a remote MCP app's risk default, tool overrides, name or description. */
export const updateRemoteMcpApp = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => updateRemoteMcpAppSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpAppService.update(context.org, data);
  });

/** Turn an MCP app of either kind on (served) or off (kept, not served). */
export const setMcpAppStatus = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setMcpAppStatusSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpAppService.setStatus(context.org, data);
  });

/**
 * Remove an MCP app: access, tokens, its tools snapshot and its place in
 * AI connections go; the credential stays set on the Gateway.
 */
export const removeMcpApp = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => mcpAppIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    await McpAppService.remove(context.org, data);
    return { removed: true };
  });

/** List an MCP app's tools again now, and say what changed. */
export const refreshMcpAppTools = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => mcpAppIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpAppService.refreshTools(context.org, data);
  });

/** An MCP app with its credential's state, its snapshot and its tools. */
export const getMcpApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => mcpAppIdSchema.parse(data))
  .handler(async ({ data, context }) => {
    return McpAppService.get(context.org, data);
  });
