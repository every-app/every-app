/**
 * An organization's monthly cap on an app's provider calls, checked at the
 * AppGateway entrypoint after a call is attributed and before anything
 * reaches a provider. Off unless an owner or admin set a cap in Admin,
 * Usage (`org_app_settings.monthly_call_cap`); a null cap never reads the
 * counter. The cap is cached per isolate like the caller rows are, so a
 * call costs one D1 read only when a cap is set.
 */
import { utcMonth } from "./usage-event";

const CAP_CACHE_MAX_ENTRIES = 500;
/** A cap that is set is re-read after this long. */
const CAP_CACHE_HIT_TTL_MS = 30_000;
/** No cap (no row, or null) is re-read after this long: a cap just set binds soon. */
const CAP_CACHE_MISS_TTL_MS = 5_000;

/** Where the caps live (OrgAppSettingsRepository in the Worker). */
interface AppCapSettings {
  /** The organization's cap on the app's provider calls per UTC month, or null. */
  monthlyCallCap(
    organizationId: string,
    appRowId: string,
  ): Promise<number | null>;
}

/** Where the month's count lives (UsageRepository in the Worker). */
export interface MonthlyCallCounter {
  /** Provider calls counted for (organization, app) in the UTC month "YYYY-MM". */
  monthlyCalls(
    organizationId: string,
    appRowId: string,
    month: string,
  ): Promise<number>;
}

export interface AppCapSources extends AppCapSettings, MonthlyCallCounter {}

const capCache = new Map<string, { cap: number | null; expiresAt: number }>();

function capKey(organizationId: string, appRowId: string): string {
  return JSON.stringify([organizationId, appRowId]);
}

/** Forget a cached cap, so one just set (or cleared) binds at once in this isolate. */
export function clearAppCapCache(
  organizationId?: string,
  appRowId?: string,
): void {
  if (organizationId !== undefined && appRowId !== undefined) {
    capCache.delete(capKey(organizationId, appRowId));
  } else {
    capCache.clear();
  }
}

async function cachedCap(
  settings: AppCapSettings,
  organizationId: string,
  appRowId: string,
): Promise<number | null> {
  const key = capKey(organizationId, appRowId);
  const now = Date.now();
  const cached = capCache.get(key);
  if (cached && cached.expiresAt > now) return cached.cap;
  if (cached) capCache.delete(key);

  const cap = await settings.monthlyCallCap(organizationId, appRowId);
  capCache.set(key, {
    cap,
    expiresAt:
      now + (cap === null ? CAP_CACHE_MISS_TTL_MS : CAP_CACHE_HIT_TTL_MS),
  });
  if (capCache.size > CAP_CACHE_MAX_ENTRIES) {
    const oldest = capCache.keys().next().value;
    if (oldest) capCache.delete(oldest);
  }
  return cap;
}

/** Seconds until the UTC month `at` is in ends, at least 1. */
export function secondsUntilUtcMonthEnd(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

type MonthlyCapCheck =
  | { exceeded: false }
  | {
      exceeded: true;
      cap: number;
      calls: number;
      month: string;
      retryAfterSeconds: number;
    };

/**
 * Whether (organization, app) has used up its month: true once the month's
 * counted calls reach the cap. With no cap set the counter is never read.
 */
export async function checkMonthlyCap(
  sources: AppCapSources,
  organizationId: string,
  appRowId: string,
  now = new Date(),
): Promise<MonthlyCapCheck> {
  const cap = await cachedCap(sources, organizationId, appRowId);
  if (cap === null) return { exceeded: false };
  const month = utcMonth(now);
  const calls = await sources.monthlyCalls(organizationId, appRowId, month);
  if (calls < cap) return { exceeded: false };
  return {
    exceeded: true,
    cap,
    calls,
    month,
    retryAfterSeconds: secondsUntilUtcMonthEnd(now),
  };
}
