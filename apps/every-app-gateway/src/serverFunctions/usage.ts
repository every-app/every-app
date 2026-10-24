import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import {
  AppCapService,
  MONTHLY_CALL_CAP_MAX,
  MONTHLY_CALL_CAP_MIN,
} from "@/server/services/AppCapService";
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

const setAppMonthlyCapSchema = z.object({
  appRowId: z.string().min(1, "App is required"),
  cap: z
    .number()
    .int("Cap must be a whole number")
    .min(MONTHLY_CALL_CAP_MIN, `Cap must be at least ${MONTHLY_CALL_CAP_MIN}`)
    .max(MONTHLY_CALL_CAP_MAX, "Cap must be at most 1,000,000,000")
    .nullable(),
});

/**
 * Set or clear the active organization's monthly cap on an app's provider
 * calls: null is unlimited, the default. Owners and admins only.
 */
export const setAppMonthlyCap = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setAppMonthlyCapSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppCapService.setMonthlyCap(context.org, data);
  });
