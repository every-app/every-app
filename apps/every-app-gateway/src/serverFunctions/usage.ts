import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import type { UsageSummary } from "@/types/usage";

const getUsageSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM"),
});

/**
 * What the active organization's apps spent in a UTC month, per app, per
 * member and per provider (Admin, Usage). Owners and admins only.
 */
export const getUsage = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => getUsageSchema.parse(data))
  .handler(async ({ data, context }): Promise<UsageSummary> => {
    return UsageRepository.summarize({
      organizationId: context.org.orgId,
      month: data.month,
    });
  });
