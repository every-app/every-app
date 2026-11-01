import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "@/server/repositories/McpToolCallRepository";

const idSchema = z.string().min(1).max(128);
/**
 * Milliseconds since the epoch, within what a Date can hold: past
 * 8.64e15 `new Date(n)` is an Invalid Date, which would bind NaN.
 */
const msSchema = z.number().int().min(0).max(8_640_000_000_000_000);

/** The filters Admin → Activity sends. Everything is optional. */
const listToolCallsSchema = z.object({
  // The previous page's `nextBefore`: created_at in milliseconds and the id.
  before: z.object({ createdAt: msSchema, id: idSchema }).optional(),
  limit: z.number().int().min(1).max(TOOL_CALL_PAGE_MAX).default(50),
  appRowId: idSchema.optional(),
  userId: idSchema.optional(),
  decision: z.enum(["allowed", "blocked"]).optional(),
  risk: z.enum(["read", "write", "destructive"]).optional(),
  // Rows from this time on.
  since: msSchema.optional(),
});

/**
 * One page of the organization's MCP tool calls (the audit trail), newest
 * first. Owners and admins only, and always the active organization's rows:
 * the organization is never taken from the input. Nothing the table does
 * not hold comes back: no arguments, no results.
 */
export const listToolCalls = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => listToolCallsSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    return McpToolCallRepository.listForOrganization({
      organizationId: context.org.orgId,
      limit: data.limit,
      before: data.before,
      appRowId: data.appRowId,
      userId: data.userId,
      decision: data.decision,
      risk: data.risk,
      since: data.since === undefined ? undefined : new Date(data.since),
    });
  });

/**
 * The apps the organization's audit trail names, for the Activity page's
 * App filter: the organization's own apps, a shared app it called (whose
 * row belongs to the platform organization) and apps since removed, which
 * the Apps list no longer carries.
 */
export const listToolCallApps = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => {
    return McpToolCallRepository.listAppsWithCalls(context.org.orgId);
  });
