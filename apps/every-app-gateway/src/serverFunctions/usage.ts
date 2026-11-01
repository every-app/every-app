import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { organizationAdminMiddleware } from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { UsageRepository } from "@/server/repositories/UsageRepository";
import {
  AppCapService,
  MONTHLY_CALL_CAP_MAX,
  MONTHLY_CALL_CAP_MIN,
  MONTHLY_COST_CAP_MAX_USD,
  MONTHLY_COST_CAP_MIN_USD,
} from "@/server/services/AppCapService";
import type { UsageSummary } from "@/types/usage";

const getUsageSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM"),
});

/**
 * What the active organization's apps spent in a UTC month, per app, per
 * member and per provider, with each app's cap and the organization's
 * default (Manage workspace → Usage). Owners and admins only.
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

const capSchema = z
  .number()
  .int("Cap must be a whole number")
  .min(MONTHLY_CALL_CAP_MIN, `Cap must be at least ${MONTHLY_CALL_CAP_MIN}`)
  .max(MONTHLY_CALL_CAP_MAX, "Cap must be at most 1,000,000,000")
  .nullable();

// Dollars with cents; AppCapService also refuses a fraction of a cent.
const costUsdSchema = z
  .number()
  .min(
    MONTHLY_COST_CAP_MIN_USD,
    `A dollar cap must be at least $${MONTHLY_COST_CAP_MIN_USD}`,
  )
  .max(MONTHLY_COST_CAP_MAX_USD, "A dollar cap must be at most $1,000,000")
  .nullable();

const setAppMonthlyCapSchema = z
  .object({
    appRowId: z.string().min(1, "App is required"),
    cap: capSchema.optional(),
    costUsd: costUsdSchema.optional(),
    unlimited: z.boolean().optional(),
  })
  .refine(
    (data) => !data.unlimited || (data.cap == null && data.costUsd == null),
    { message: "An app has a cap or no cap, not both", path: ["unlimited"] },
  );

/**
 * Set the active organization's caps on an app's provider calls (`cap`
 * in calls, `costUsd` in dollars of provider-reported cost; one left out
 * keeps what the app has), say the app has none whatever the defaults
 * (`unlimited`), or neither (both null, not unlimited): the defaults
 * apply, and without them the app is unlimited. Owners and admins only.
 */
export const setAppMonthlyCap = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setAppMonthlyCapSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppCapService.setMonthlyCap(context.org, data);
  });

const setDefaultMonthlyCapSchema = z.object({
  cap: capSchema.optional(),
  costUsd: costUsdSchema.optional(),
});

/**
 * Set or clear the active organization's default caps (calls, dollars;
 * one left out is kept), which bind every app without a cap of that kind
 * or "no cap" of its own. Owners and admins only.
 */
export const setDefaultMonthlyCap = createServerFn({ method: "POST" })
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .validator((data: unknown) => setDefaultMonthlyCapSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppCapService.setDefaultMonthlyCap(context.org, data);
  });
