import { logEvent } from "@every-app/perimeter";
import { AppRepository } from "../repositories/AppRepository";
import { OrgAppSettingsRepository } from "../repositories/OrgAppSettingsRepository";
import { OrgSettingsRepository } from "../repositories/OrgSettingsRepository";
import {
  clearAppCapCache,
  microsToUsd,
  type EffectiveCaps,
} from "@/server/app-cap";
import type { AppCapState } from "@/types/usage";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue } from "@/server/events/catalogue";
import { actorFor } from "@/server/events/subjects";
import { EventSubscriptionService } from "@/server/events/subscriptions";
import type { OrgContext } from "@/server/organization/orgContext";

/** Caps are whole provider calls per month, up to a billion. */
export const MONTHLY_CALL_CAP_MIN = 1;
export const MONTHLY_CALL_CAP_MAX = 1_000_000_000;
/**
 * Dollar caps are US dollars of provider-reported cost per month, in
 * whole cents, from a cent to a million dollars; stored in micro-dollars,
 * the unit `usage_monthly.cost_micros` counts in.
 */
export const MONTHLY_COST_CAP_MIN_USD = 0.01;
export const MONTHLY_COST_CAP_MAX_USD = 1_000_000;

function assertCap(cap: number | null | undefined): void {
  if (
    cap !== null &&
    cap !== undefined &&
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
 * A dollar cap as stored: whole cents to micro-dollars, null for none,
 * undefined left as it is. Refused out of range or finer than a cent.
 */
function costCapMicros(
  usd: number | null | undefined,
): number | null | undefined {
  if (usd === null || usd === undefined) return usd;
  const cents = Math.round(usd * 100);
  if (
    !Number.isFinite(usd) ||
    Math.abs(usd * 100 - cents) > 1e-6 ||
    usd < MONTHLY_COST_CAP_MIN_USD ||
    usd > MONTHLY_COST_CAP_MAX_USD
  ) {
    throw new PublicError(
      "INVALID_INPUT",
      `A monthly dollar cap is from $${MONTHLY_COST_CAP_MIN_USD} to $${MONTHLY_COST_CAP_MAX_USD.toLocaleString("en-US")}, in whole cents.`,
    );
  }
  return cents * 10_000;
}

/** Dollars, or null, as the events carry a dollar cap. */
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
 * hear. A lowered cap is not an event. For an app the two caps are the ones
 * that bound it before and after (its own, else the default), so a cap set
 * under the default is no raise, and `unlimited` under a default is a
 * removal. Each kind is judged on its own.
 */
function raised(cap: number | null, previousCap: number | null): boolean {
  return cap === null
    ? previousCap !== null
    : previousCap === null || cap > previousCap;
}

/**
 * The fields of `cap.raised` for a change from `before` to `after`, or
 * null when neither kind ended higher or gone. The call cap is always
 * there, as before dollar caps; the dollar cap (in dollars) only when it
 * changed.
 */
function raisedCaps(
  after: { calls: number | null; cost: number | null },
  before: { calls: number | null; cost: number | null },
): {
  cap: number | null;
  previousCap: number | null;
  costCap?: number | null;
  previousCostCap?: number | null;
} | null {
  if (!raised(after.calls, before.calls) && !raised(after.cost, before.cost)) {
    return null;
  }
  return {
    cap: after.calls,
    previousCap: before.calls,
    ...(after.cost !== before.cost && {
      costCap: usd(after.cost),
      previousCostCap: usd(before.cost),
    }),
  };
}

/**
 * The fields of `cap.changed` for a change from `before` to `after` that
 * `raisedCaps` did not announce (a cap lowered or set under the default),
 * or null when nothing changed. Same shape as `cap.raised`.
 */
function changedCaps(
  after: { calls: number | null; cost: number | null },
  before: { calls: number | null; cost: number | null },
): {
  cap: number | null;
  previousCap: number | null;
  costCap?: number | null;
  previousCostCap?: number | null;
} | null {
  if (after.calls === before.calls && after.cost === before.cost) return null;
  return {
    cap: after.calls,
    previousCap: before.calls,
    ...(after.cost !== before.cost && {
      costCap: usd(after.cost),
      previousCostCap: usd(before.cost),
    }),
  };
}

const bound = (caps: EffectiveCaps) => ({
  calls: caps.calls.cap,
  cost: caps.cost.cap,
});

/**
 * Set the organization's caps on an app's provider calls (Manage workspace
 * → Usage): a number of calls (`cap`) and dollars of provider-reported
 * cost (`costUsd`), each a number, null for none of its own, or left out
 * to keep what the app has; or say the app has none whatever the defaults
 * (`unlimited`); or neither cap, so the defaults apply (and without them
 * the app is unlimited). A cap of either kind ends `unlimited`, and the
 * kind not set then follows its default. The app must be one the
 * organization calls: its own, or a shared app, which every organization
 * caps on its own since the count is per organization. Owners and admins
 * only (the server function's gate). The caps bind at once in this
 * isolate and within seconds elsewhere. When a cap that binds the app
 * ends higher or gone, that is announced on the event bus (`cap.raised`,
 * with the caps that bound it before and after); the organization's first
 * cap makes its "Cap alerts" subscription.
 */
async function setMonthlyCap(
  ctx: OrgContext,
  input: {
    appRowId: string;
    cap?: number | null;
    costUsd?: number | null;
    unlimited?: boolean;
  },
): Promise<AppCapState> {
  const app = await AppRepository.findCallableById(input.appRowId, ctx.orgId);
  if (!app) throw new PublicError("APP_NOT_FOUND", "App not found");
  const unlimited = input.unlimited ?? false;
  if (unlimited && (input.cap != null || input.costUsd != null)) {
    throw new PublicError(
      "INVALID_INPUT",
      "An app has a cap or no cap, not both.",
    );
  }
  if (!unlimited && input.cap === undefined && input.costUsd === undefined) {
    throw new PublicError(
      "INVALID_INPUT",
      "Give a cap in calls, a cap in dollars, or unlimited.",
    );
  }
  assertCap(input.cap);
  const costCap = costCapMicros(input.costUsd);
  const row = await OrgAppSettingsRepository.getAppCapRow(ctx.orgId, app.id);
  const cap = unlimited
    ? null
    : input.cap === undefined
      ? row.monthlyCallCap
      : input.cap;
  const cost = unlimited
    ? null
    : costCap === undefined
      ? row.monthlyCostCapMicros
      : costCap;
  const before = await OrgAppSettingsRepository.getEffectiveMonthlyCaps(
    ctx.orgId,
    app.id,
  );
  await OrgAppSettingsRepository.setMonthlyCap({
    organizationId: ctx.orgId,
    appRowId: app.id,
    cap,
    costCapMicros: cost,
    unlimited,
    updatedBy: ctx.userId,
  });
  clearAppCapCache(ctx.orgId, app.id);
  const effective = await OrgAppSettingsRepository.getEffectiveMonthlyCaps(
    ctx.orgId,
    app.id,
  );
  if (cap !== null || cost !== null) await ensureCapAlerts(ctx.orgId);
  const eventApp = { id: app.appSlug, rowId: app.id, name: app.name };
  const change = raisedCaps(bound(effective), bound(before));
  if (change) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.capRaised({ app: eventApp, ...change, source: "app" }),
    }));
  } else {
    // Lowered, set under the default, or the row changed while the binding
    // caps stayed (its own cap at the default's value, `unlimited` taken
    // back under none): cap.changed, cap.raised's counterpart.
    const changed =
      changedCaps(bound(effective), bound(before)) ??
      (effective.calls.source !== before.calls.source ||
      effective.cost.source !== before.cost.source
        ? { cap: effective.calls.cap, previousCap: before.calls.cap }
        : null);
    if (changed) {
      await emit(async () => ({
        organizationId: ctx.orgId,
        actor: await actorFor(ctx),
        ...catalogue.capChanged({ app: eventApp, ...changed, source: "app" }),
      }));
    }
  }
  logEvent("usage.cap_set", {
    organizationId: ctx.orgId,
    appId: app.appSlug,
    appRowId: app.id,
    cap,
    costCapMicros: cost,
    unlimited,
    userId: ctx.userId,
  });
  return {
    appRowId: app.id,
    monthlyCallCap: cap,
    monthlyCostCapMicros: cost,
    capUnlimited: unlimited,
    effectiveMonthlyCallCap: effective.calls.cap,
    capSource: effective.calls.source,
    effectiveMonthlyCostCapMicros: effective.cost.cap,
    costCapSource: effective.cost.source,
  };
}

/**
 * Set or clear the organization's default caps: what binds every app
 * without a cap of that kind (or `unlimited`) of its own. `cap` in calls
 * and `costUsd` in dollars, each a number, null for no default, or left
 * out to keep it. Every cached cap is forgotten, since any app may have
 * been reading the defaults. Raised or removed, either is announced as
 * `cap.raised` with `source: "default"` and no app; the first cap,
 * default or an app's, makes the "Cap alerts" subscription.
 */
async function setDefaultMonthlyCap(
  ctx: OrgContext,
  input: { cap?: number | null; costUsd?: number | null },
): Promise<{
  defaultMonthlyCallCap: number | null;
  defaultMonthlyCostCapMicros: number | null;
}> {
  if (input.cap === undefined && input.costUsd === undefined) {
    throw new PublicError(
      "INVALID_INPUT",
      "Give a default cap in calls, in dollars, or both.",
    );
  }
  assertCap(input.cap);
  const costCap = costCapMicros(input.costUsd);
  const previous = await OrgSettingsRepository.getDefaultMonthlyCaps(ctx.orgId);
  const cap = input.cap === undefined ? previous.cap : input.cap;
  const cost = costCap === undefined ? previous.costCapMicros : costCap;
  await OrgSettingsRepository.setDefaultMonthlyCaps({
    organizationId: ctx.orgId,
    cap,
    costCapMicros: cost,
    updatedBy: ctx.userId,
  });
  clearAppCapCache();
  if (cap !== null || cost !== null) await ensureCapAlerts(ctx.orgId);
  const after = { calls: cap, cost };
  const previously = { calls: previous.cap, cost: previous.costCapMicros };
  const change = raisedCaps(after, previously);
  const changed = change ? null : changedCaps(after, previously);
  if (change) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.capRaised({ app: null, ...change, source: "default" }),
    }));
  } else if (changed) {
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.capChanged({ app: null, ...changed, source: "default" }),
    }));
  }
  logEvent("usage.default_cap_set", {
    organizationId: ctx.orgId,
    cap,
    costCapMicros: cost,
    userId: ctx.userId,
  });
  return { defaultMonthlyCallCap: cap, defaultMonthlyCostCapMicros: cost };
}

export const AppCapService = { setMonthlyCap, setDefaultMonthlyCap } as const;
