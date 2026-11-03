import { logEvent } from "@every-app/perimeter";
import { AppRepository } from "../repositories/AppRepository";
import { OrgAppSettingsRepository } from "../repositories/OrgAppSettingsRepository";
import { OrgSettingsRepository } from "../repositories/OrgSettingsRepository";
import {
  clearAppCapCache,
  microsToUsd,
  type EffectiveCap,
} from "@/server/app-cap";
import type { AppCapState } from "@/types/usage";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { actorFor } from "@/server/events/subjects";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import type { OrgContext } from "@/server/organization/orgContext";

/**
 * Caps are US dollars of provider-reported cost per month, in whole
 * cents, from a cent to a million dollars; stored in micro-dollars, the
 * unit `usage_monthly.cost_micros` counts in.
 */
export const MONTHLY_COST_CAP_MIN_USD = 0.01;
export const MONTHLY_COST_CAP_MAX_USD = 1_000_000;

/**
 * A cap as stored: whole cents to micro-dollars, null for none. Refused out
 * of range or finer than a cent.
 */
function costCapMicros(usd: number | null): number | null {
  if (usd === null) return null;
  const cents = Math.round(usd * 100);
  if (
    !Number.isFinite(usd) ||
    Math.abs(usd * 100 - cents) > 1e-6 ||
    usd < MONTHLY_COST_CAP_MIN_USD ||
    usd > MONTHLY_COST_CAP_MAX_USD
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      `A monthly cap is from $${MONTHLY_COST_CAP_MIN_USD} to $${MONTHLY_COST_CAP_MAX_USD.toLocaleString("en-US")}, in whole cents.`,
    );
  }
  return cents * 10_000;
}

/** Dollars, or null, as the events carry a cap. */
const usd = (micros: number | null): number | null =>
  micros === null ? null : microsToUsd(micros);

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
 * hear. A lowered cap is not a raise. For an app the two caps are the ones
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
 * Announce a change from `before` to `after` on the event bus: `cap.raised`
 * when the cap ended higher or gone, else `cap.changed` when the cap or
 * where it comes from changed (lowered, set under the default, its own cap
 * at the default's value); nothing when neither did.
 */
async function announce(
  ctx: OrgContext,
  app: { id: string; rowId: string; name: string } | null,
  after: EffectiveCap,
  before: EffectiveCap,
): Promise<void> {
  const source = app ? "app" : "default";
  const change = {
    app,
    costCap: usd(after.cap),
    previousCostCap: usd(before.cap),
    source,
  } as const;
  if (raised(after.cap, before.cap)) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.capRaised(change),
    }));
  } else if (after.cap !== before.cap || after.source !== before.source) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.capChanged(change),
    }));
  }
}

/**
 * Set the organization's cap on an app's provider calls (Manage workspace
 * → Usage): dollars of provider-reported cost (`costUsd`), or null for
 * none of its own so the default applies (and without one the app is
 * unlimited); or say the app has none whatever the default (`unlimited`).
 * The app must be one the organization calls: its own, or a shared app,
 * which every organization caps on its own since the count is per
 * organization. Owners and admins only (the server function's gate). The
 * cap binds at once in this isolate and within seconds elsewhere. The
 * change is announced on the event bus (`cap.raised` or `cap.changed`,
 * with the caps that bound the app before and after); the organization's
 * first cap makes its "Cap alerts" subscription.
 */
async function setMonthlyCap(
  ctx: OrgContext,
  input: {
    appRowId: string;
    costUsd?: number | null;
    unlimited?: boolean;
  },
): Promise<AppCapState> {
  const app = await AppRepository.findCallableById(input.appRowId, ctx.orgId);
  if (!app) throw new PublicError("APP_NOT_FOUND", "App not found");
  const unlimited = input.unlimited ?? false;
  if (unlimited && input.costUsd != null) {
    throw new PublicError(
      "INVALID_INPUT",
      "An app has a cap or no cap, not both.",
    );
  }
  if (!unlimited && input.costUsd === undefined) {
    throw new PublicError(
      "INVALID_INPUT",
      "Give a cap in dollars, null for none of its own, or unlimited.",
    );
  }
  const cost = unlimited ? null : costCapMicros(input.costUsd ?? null);
  const before = await OrgAppSettingsRepository.getEffectiveMonthlyCap(
    ctx.orgId,
    app.id,
  );
  await OrgAppSettingsRepository.setMonthlyCap({
    organizationId: ctx.orgId,
    appRowId: app.id,
    costCapMicros: cost,
    unlimited,
    updatedBy: ctx.userId,
  });
  clearAppCapCache(ctx.orgId, app.id);
  const effective = await OrgAppSettingsRepository.getEffectiveMonthlyCap(
    ctx.orgId,
    app.id,
  );
  if (cost !== null) await ensureCapAlerts(ctx.orgId);
  await announce(
    ctx,
    { id: app.appSlug, rowId: app.id, name: app.name },
    effective,
    before,
  );
  logEvent("usage.cap_set", {
    organizationId: ctx.orgId,
    appId: app.appSlug,
    appRowId: app.id,
    costCapMicros: cost,
    unlimited,
    userId: ctx.userId,
  });
  return {
    appRowId: app.id,
    monthlyCostCapMicros: cost,
    capUnlimited: unlimited,
    effectiveMonthlyCostCapMicros: effective.cap,
    costCapSource: effective.source,
  };
}

/**
 * Set or clear the organization's default cap: what binds every app
 * without a cap (or `unlimited`) of its own, in dollars (`costUsd`), or
 * null for no default. Every cached cap is forgotten, since any app may
 * have been reading the default. The change is announced as `cap.raised`
 * or `cap.changed` with `source: "default"` and no app; the first cap,
 * default or an app's, makes the "Cap alerts" subscription.
 */
async function setDefaultMonthlyCap(
  ctx: OrgContext,
  input: { costUsd: number | null },
): Promise<{ defaultMonthlyCostCapMicros: number | null }> {
  const cost = costCapMicros(input.costUsd);
  const previous = await OrgSettingsRepository.getDefaultMonthlyCap(ctx.orgId);
  await OrgSettingsRepository.setDefaultMonthlyCap({
    organizationId: ctx.orgId,
    costCapMicros: cost,
    updatedBy: ctx.userId,
  });
  clearAppCapCache();
  if (cost !== null) await ensureCapAlerts(ctx.orgId);
  const bound = (cap: number | null): EffectiveCap => ({
    cap,
    source: cap === null ? null : "default",
  });
  await announce(ctx, null, bound(cost), bound(previous));
  logEvent("usage.default_cap_set", {
    organizationId: ctx.orgId,
    costCapMicros: cost,
    userId: ctx.userId,
  });
  return { defaultMonthlyCostCapMicros: cost };
}

export const AppCapService = { setMonthlyCap, setDefaultMonthlyCap } as const;
