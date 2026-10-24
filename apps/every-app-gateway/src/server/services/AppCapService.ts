import { logEvent } from "@every-app/perimeter";
import { AppRepository } from "../repositories/AppRepository";
import { OrgAppSettingsRepository } from "../repositories/OrgAppSettingsRepository";
import { clearAppCapCache } from "@/server/app-cap";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";

/** Caps are whole provider calls per month, up to a billion. */
export const MONTHLY_CALL_CAP_MIN = 1;
export const MONTHLY_CALL_CAP_MAX = 1_000_000_000;

/**
 * Set or clear the organization's monthly cap on an app's provider calls
 * (Admin, Usage). The app must be one the organization calls: its own, or a
 * shared app, which every organization caps on its own since the count is
 * per organization. Owners and admins only (the server function's gate).
 * The cap binds at once in this isolate and within seconds elsewhere.
 */
async function setMonthlyCap(
  ctx: OrgContext,
  input: { appRowId: string; cap: number | null },
): Promise<{ appRowId: string; monthlyCallCap: number | null }> {
  const app = await AppRepository.findCallableById(input.appRowId, ctx.orgId);
  if (!app) throw new PublicError("APP_NOT_FOUND", "App not found");
  if (
    input.cap !== null &&
    (!Number.isInteger(input.cap) ||
      input.cap < MONTHLY_CALL_CAP_MIN ||
      input.cap > MONTHLY_CALL_CAP_MAX)
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      `A monthly cap is a whole number from ${MONTHLY_CALL_CAP_MIN} to ${MONTHLY_CALL_CAP_MAX.toLocaleString("en-US")}.`,
    );
  }
  await OrgAppSettingsRepository.setMonthlyCap({
    organizationId: ctx.orgId,
    appRowId: app.id,
    cap: input.cap,
    updatedBy: ctx.userId,
  });
  clearAppCapCache(ctx.orgId, app.id);
  logEvent("usage.cap_set", {
    organizationId: ctx.orgId,
    appId: app.appSlug,
    appRowId: app.id,
    cap: input.cap,
    userId: ctx.userId,
  });
  return { appRowId: app.id, monthlyCallCap: input.cap };
}

export const AppCapService = { setMonthlyCap } as const;
