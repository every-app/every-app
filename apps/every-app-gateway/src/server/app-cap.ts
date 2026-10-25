/**
 * An organization's monthly cap on an app's provider calls, checked at the
 * AppGateway entrypoint after a call is attributed and before anything
 * reaches a provider. Off unless an owner or admin set a cap on the app or
 * a default for every app under Manage workspace → Usage
 * (`org_app_settings`, `org_settings`); with no cap the counter is never
 * read. The effective cap is cached per isolate like the caller rows are,
 * so a call costs one D1 read only when a cap is set.
 */
import { utcMonth } from "./usage-event";

const CAP_CACHE_MAX_ENTRIES = 500;
/** A cap that is set is re-read after this long. */
const CAP_CACHE_HIT_TTL_MS = 30_000;
/** No cap (no row, or null) is re-read after this long: a cap just set binds soon. */
const CAP_CACHE_MISS_TTL_MS = 5_000;

/** Where a binding cap came from: the app's own row, or the organization's default. */
export type CapSource = "app" | "default";

/** The cap that binds (organization, app) this month, and where it came from. */
export interface EffectiveCap {
  cap: number | null;
  source: CapSource | null;
}

/**
 * The rule, from the organization's row on the app and its default: a cap
 * on the row wins (even next to `unlimited`, which fails safe); then
 * `unlimited` says none; then the default; then none.
 */
export function effectiveMonthlyCap(input: {
  appCap: number | null;
  unlimited: boolean;
  defaultCap: number | null;
}): EffectiveCap {
  if (input.appCap !== null) return { cap: input.appCap, source: "app" };
  if (input.unlimited) return { cap: null, source: null };
  if (input.defaultCap !== null) {
    return { cap: input.defaultCap, source: "default" };
  }
  return { cap: null, source: null };
}

/** Where the caps live (OrgAppSettingsRepository in the Worker). */
interface AppCapSettings {
  /** The cap that binds the app's provider calls for the organization this month. */
  effectiveMonthlyCap(
    organizationId: string,
    appRowId: string,
  ): Promise<EffectiveCap>;
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

const capCache = new Map<string, { cap: EffectiveCap; expiresAt: number }>();

function capKey(organizationId: string, appRowId: string): string {
  return JSON.stringify([organizationId, appRowId]);
}

/**
 * Forget a cached cap, so one just set (or cleared) binds at once in this
 * isolate: the (organization, app) entry after an app's cap changed, every
 * entry after a default changed.
 */
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
): Promise<EffectiveCap> {
  const key = capKey(organizationId, appRowId);
  const now = Date.now();
  const cached = capCache.get(key);
  if (cached && cached.expiresAt > now) return cached.cap;
  if (cached) capCache.delete(key);

  const cap = await settings.effectiveMonthlyCap(organizationId, appRowId);
  capCache.set(key, {
    cap,
    expiresAt:
      now + (cap.cap === null ? CAP_CACHE_MISS_TTL_MS : CAP_CACHE_HIT_TTL_MS),
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

/** The month's standing against a cap that binds: the count so far, and where the cap came from. */
interface CappedMonth {
  cap: number;
  calls: number;
  /** "YYYY-MM" */
  month: string;
  source: CapSource;
}

export type MonthlyCapCheck =
  | { exceeded: false; cap?: undefined }
  | ({ exceeded: false } & CappedMonth)
  | ({ exceeded: true; retryAfterSeconds: number } & CappedMonth);

/**
 * Whether (organization, app) has used up its month: true once the month's
 * counted calls reach the cap. With no cap set the counter is never read
 * and nothing else is reported; with one, the standing comes back either
 * way, so the caller can warn at 80% (server/events/cap-events.ts), with
 * where the cap came from: the app's own row, or the organization's
 * default.
 */
export async function checkMonthlyCap(
  sources: AppCapSources,
  organizationId: string,
  appRowId: string,
  now = new Date(),
): Promise<MonthlyCapCheck> {
  const { cap, source } = await cachedCap(sources, organizationId, appRowId);
  if (cap === null || source === null) return { exceeded: false };
  const month = utcMonth(now);
  const calls = await sources.monthlyCalls(organizationId, appRowId, month);
  const standing: CappedMonth = { cap, calls, month, source };
  if (calls < cap) return { exceeded: false, ...standing };
  return {
    exceeded: true,
    ...standing,
    retryAfterSeconds: secondsUntilUtcMonthEnd(now),
  };
}

/**
 * The alert threshold a count has reached: 100 at the cap, 80 from four
 * fifths of it (rounded up, so a cap of 1 goes straight to 100), none below.
 */
export function capThreshold(calls: number, cap: number): 100 | 80 | null {
  if (calls >= cap) return 100;
  if (calls >= Math.ceil(cap * 0.8)) return 80;
  return null;
}

/**
 * What a refused call is told, at the entrypoint (the 429's body, which
 * the app's code and its OpenAI client read) and in a provider tool's
 * error (which a connected agent reads): the cap, where it came from, and
 * who raises it, by role. Never a name or an address: the directory goes
 * only to apps holding the `members` capability, never to agents.
 */
export function capRefusalMessage(
  name: string,
  check: CappedMonth & { exceeded: true },
): string {
  const from = check.source === "default" ? " (the workspace default)" : "";
  return `${name} has reached its monthly cap of ${check.cap.toLocaleString("en-US")} provider calls for this organization${from}. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.`;
}
