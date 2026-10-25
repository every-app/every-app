import { logEvent } from "@every-app/perimeter";
import { AppRepository } from "../repositories/AppRepository";
import { OrgAppSettingsRepository } from "../repositories/OrgAppSettingsRepository";
import { OrgSettingsRepository } from "../repositories/OrgSettingsRepository";
import { clearAppCapCache } from "@/server/app-cap";
import type { AppCapState } from "@/types/usage";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { userActor } from "@/server/events/subjects";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import type { OrgContext } from "@/server/organization/orgContext";

/** Caps are whole provider calls per month, up to a billion. */
export const MONTHLY_CALL_CAP_MIN = 1;
export const MONTHLY_CALL_CAP_MAX = 1_000_000_000;

function assertCap(cap: number | null): void {
  if (
    cap !== null &&
    (!Number.isInteger(cap) ||
      cap < MONTHLY_CALL_CAP_MIN ||
      cap > MONTHLY_CALL_CAP_MAX)
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      `A monthly cap is a whole number from ${MONTHLY_CALL_CAP_MIN} to ${MONTHLY_CALL_CAP_MAX.toLocaleString("en-US")}.`,
    );
  }
}

/**
 * The organization's built-in "Cap alerts" email subscription, made with
 * its first cap, an app's or the default (docs/design/2026-10-events-out.md,
 * section 6). The cap is set either way; a row that can't be made is logged.
 */
async function ensureCapAlerts(organizationId: string): Promise<void> {
  await EventSubscriptionService.ensureCapAlerts(organizationId).catch(
    (error: unknown) =>
      logEvent(
        "events.cap_alerts_failed",
        {
          organizationId,
          message: error instanceof Error ? error.message : String(error),
        },
        "error",
      ),
  );
}

/**
 * Set, raised, or removed: what a person waiting on a paused app wants to
 * hear. A lowered cap is not an event. For an app the two caps are the ones
 * that bound it before and after (its own, else the default), so a cap set
 * under the default is no raise, and `unlimited` under a default is a
 * removal.
 */
function raised(cap: number | null, previousCap: number | null): boolean {
  return cap === null
    ? previousCap !== null
    : previousCap === null || cap > previousCap;
}

/**
 * Set the organization's cap on an app's provider calls (Manage workspace
 * → Usage), say the app has none whatever the default (`unlimited`), or
 * neither, so the default applies (and without one the app is unlimited).
 * The app must be one the organization calls: its own, or a shared app,
 * which every organization caps on its own since the count is per
 * organization. Owners and admins only (the server function's gate). The
 * cap binds at once in this isolate and within seconds elsewhere. When the
 * cap that binds the app ends higher or gone, that is announced on the
 * event bus (`cap.raised`, with the caps that bound it before and after);
 * the organization's first cap makes its "Cap alerts" subscription.
 */
async function setMonthlyCap(
  ctx: OrgContext,
  input: { appRowId: string; cap: number | null; unlimited?: boolean },
): Promise<AppCapState> {
  const app = await AppRepository.findCallableById(input.appRowId, ctx.orgId);
  if (!app) throw new PublicError("APP_NOT_FOUND", "App not found");
  const unlimited = input.unlimited ?? false;
  if (input.cap !== null && unlimited) {
    throw new PublicError(
      "INVALID_INPUT",
      "An app has a cap or no cap, not both.",
    );
  }
  assertCap(input.cap);
  const before = await OrgAppSettingsRepository.getEffectiveMonthlyCap(
    ctx.orgId,
    app.id,
  );
  await OrgAppSettingsRepository.setMonthlyCap({
    organizationId: ctx.orgId,
    appRowId: app.id,
    cap: input.cap,
    unlimited,
    updatedBy: ctx.userId,
  });
  clearAppCapCache(ctx.orgId, app.id);
  const effective = await OrgAppSettingsRepository.getEffectiveMonthlyCap(
    ctx.orgId,
    app.id,
  );
  if (input.cap !== null) await ensureCapAlerts(ctx.orgId);
  if (raised(effective.cap, before.cap)) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.capRaised({
        app: { id: app.appSlug, rowId: app.id, name: app.name },
        cap: effective.cap,
        previousCap: before.cap,
        source: "app",
      }),
    }));
  }
  logEvent("usage.cap_set", {
    organizationId: ctx.orgId,
    appId: app.appSlug,
    appRowId: app.id,
    cap: input.cap,
    unlimited,
    userId: ctx.userId,
  });
  return {
    appRowId: app.id,
    monthlyCallCap: input.cap,
    capUnlimited: unlimited,
    effectiveMonthlyCallCap: effective.cap,
    capSource: effective.source,
  };
}

/**
 * Set or clear the organization's default cap: what binds every app
 * without a row of its own. Every cached cap is forgotten, since any app
 * may have been reading the default. Raised or removed, it is announced
 * as `cap.raised` with `source: "default"` and no app; the first cap,
 * default or an app's, makes the "Cap alerts" subscription.
 */
async function setDefaultMonthlyCap(
  ctx: OrgContext,
  input: { cap: number | null },
): Promise<{ defaultMonthlyCallCap: number | null }> {
  assertCap(input.cap);
  const previousCap = await OrgSettingsRepository.getDefaultMonthlyCap(
    ctx.orgId,
  );
  await OrgSettingsRepository.setDefaultMonthlyCap({
    organizationId: ctx.orgId,
    cap: input.cap,
    updatedBy: ctx.userId,
  });
  clearAppCapCache();
  if (input.cap !== null) await ensureCapAlerts(ctx.orgId);
  if (raised(input.cap, previousCap)) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await userActor(ctx.userId),
      ...catalogue.capRaised({
        app: null,
        cap: input.cap,
        previousCap,
        source: "default",
      }),
    }));
  }
  logEvent("usage.default_cap_set", {
    organizationId: ctx.orgId,
    cap: input.cap,
    userId: ctx.userId,
  });
  return { defaultMonthlyCallCap: input.cap };
}

export const AppCapService = { setMonthlyCap, setDefaultMonthlyCap } as const;
