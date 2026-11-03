/**
 * An organization's monthly cap in dollars on an app's provider calls,
 * checked at the AppGateway entrypoint after a call is attributed and
 * before anything reaches a provider. Off unless an owner or admin set it
 * on the app or as a default for every app under Manage workspace → Usage
 * (`org_app_settings`, `org_settings`). It counts the cost the providers
 * report (OpenRouter's `usage.cost`, DataForSEO's `cost`); a call to a
 * provider that reports none never moves it. With no cap the counter is
 * never read. The effective cap is cached per isolate like the caller rows
 * are, so a call costs one D1 read only when a cap is set.
 */
import { utcMonth } from "./usage-event";

const CAP_CACHE_MAX_ENTRIES = 500;
/** A cap that is set is re-read after this long. */
const CAP_CACHE_HIT_TTL_MS = 30_000;
/** No cap (no row, or null) is re-read after this long: a cap just set binds soon. */
const CAP_CACHE_MISS_TTL_MS = 5_000;

/** Where a binding cap came from: the app's own row, or the organization's default. */
export type CapSource = "app" | "default";

/**
 * The cap that binds (organization, app) this month, in millionths of a US
 * dollar (as `usage_monthly.cost_micros` counts), and where it came from.
 */
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

/** Where the month's counts live (UsageRepository in the Worker). */
export interface MonthlyCostCounter {
  /** Provider-reported cost in micro-dollars for (organization, app) in the UTC month "YYYY-MM". */
  monthlyCostMicros(
    organizationId: string,
    appRowId: string,
    month: string,
  ): Promise<number>;
}

export interface AppCapSources extends AppCapSettings, MonthlyCostCounter {}

const capCache = new Map<string, { cap: EffectiveCap; expiresAt: number }>();

function capKey(organizationId: string, appRowId: string): string {
  return JSON.stringify([organizationId, appRowId]);
}

/**
 * Forget a cached cap, so one just set (or cleared) binds at once in this
 * isolate: the (organization, app) entry after an app's cap changed, every
 * entry after the default changed.
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
      now + (cap.cap !== null ? CAP_CACHE_HIT_TTL_MS : CAP_CACHE_MISS_TTL_MS),
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

/** The cap that binds this month, and the month's use against it, both in micro-dollars. */
export interface CapStanding {
  cap: number;
  used: number;
  source: CapSource;
}

/** The month's standing against the cap that binds. */
interface CappedMonth {
  /** "YYYY-MM" */
  month: string;
  standing: CapStanding;
}

export type MonthlyCapCheck =
  | { exceeded: false; standing?: undefined }
  | ({ exceeded: false } & CappedMonth)
  | ({ exceeded: true; retryAfterSeconds: number } & CappedMonth);

/**
 * Whether (organization, app) has used up its month: true once the cost
 * the providers reported this month reaches the cap. With no cap set the
 * counter is never read and nothing else is reported; with one, the
 * standing comes back either way, so the caller can warn at 80%
 * (server/events/cap-events.ts), with where the cap came from: the app's
 * own row, or the organization's default.
 */
export async function checkMonthlyCap(
  sources: AppCapSources,
  organizationId: string,
  appRowId: string,
  now = new Date(),
): Promise<MonthlyCapCheck> {
  const effective = await cachedCap(sources, organizationId, appRowId);
  if (effective.cap === null || effective.source === null) {
    return { exceeded: false };
  }
  const month = utcMonth(now);
  const used = await sources.monthlyCostMicros(organizationId, appRowId, month);
  const standing: CapStanding = {
    cap: effective.cap,
    used,
    source: effective.source,
  };
  if (used < effective.cap) return { exceeded: false, month, standing };
  return {
    exceeded: true,
    month,
    standing,
    retryAfterSeconds: secondsUntilUtcMonthEnd(now),
  };
}

/**
 * What the `usage.cap_exceeded` log line says of a refusal: the cap, where
 * it came from, and the month's reported cost.
 */
export function capExceededFields(
  check: Extract<MonthlyCapCheck, { exceeded: true }>,
): Record<string, string | number> {
  return {
    capMicros: check.standing.cap,
    source: check.standing.source,
    costMicros: check.standing.used,
    month: check.month,
  };
}

/** Micro-dollars as whole US dollars and cents, the unit the events and the tools speak. */
export function microsToUsd(micros: number): number {
  return Math.round(micros / 10_000) / 100;
}

/** Micro-dollars as a person reads them: "$1,250.00". */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / 1_000_000).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
  check: { standing: CapStanding },
): string {
  const from =
    check.standing.source === "default" ? " (the workspace default)" : "";
  return `${name} has reached its monthly cap of ${formatUsdMicros(check.standing.cap)} of provider-reported cost for this organization${from}. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.`;
}
