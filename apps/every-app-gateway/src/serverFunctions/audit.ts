import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AUDIT_PAGE_MAX } from "@every-app/sdk/internal";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_TYPE_FILTER_MAX,
  AUDIT_TYPE_FILTER_PATTERN,
  listAudit,
  listAuditActors as listActors,
} from "@/server/events/audit";

const idSchema = z.string().min(1).max(128);
/** Milliseconds since the epoch, inside what a Date can hold (past it `new Date(n)` is invalid). */
const msSchema = z.number().int().min(0).max(8_640_000_000_000_000);

/** The filters Admin → Activity → Audit sends. Everything is optional. */
const listAuditSchema = z.object({
  // The previous page's `nextBefore`: time in milliseconds and the id.
  before: z.object({ time: msSchema, id: idSchema }).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUDIT_PAGE_MAX)
    .default(AUDIT_LIMIT_DEFAULT),
  // `actor_id`: a user id, a credential id, an app id, an operator.
  actorId: idSchema.optional(),
  // A type, a prefix (`member.*`) or `*`; absent, ping and tool.* stay out.
  type: z
    .string()
    .min(1)
    .max(AUDIT_TYPE_FILTER_MAX)
    .regex(AUDIT_TYPE_FILTER_PATTERN)
    .optional(),
  // Rows from this time on.
  since: msSchema.optional(),
});

/**
 * One page of the organization's audit log (its events read back as a
 * trail), newest first. Owners and admins only, and always the active
 * organization's rows: the organization is never taken from the input.
 * Each row carries the type, its summary, who and what about; never the
 * event's data.
 */
export const listAuditEvents = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => listAuditSchema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    return listAudit(context.org.orgId, {
      limit: data.limit,
      before: data.before,
      actorId: data.actorId,
      type: data.type,
      since: data.since === undefined ? undefined : new Date(data.since),
    });
  });

/**
 * The actors the organization's audit log names, for the Who filter:
 * members (by their current name), AI clients, apps, the CLI's operators
 * and the gateway itself, with how many events each caused.
 */
export const listAuditActors = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .handler(async ({ context }) => {
    return listActors(context.org.orgId);
  });
