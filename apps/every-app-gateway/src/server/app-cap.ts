/**
 * An organization's monthly caps on an app's provider calls, checked at the
 * AppGateway entrypoint after a call is attributed and before anything
 * reaches a provider. Two kinds, each off unless an owner or admin set it
 * on the app or as a default for every app under Manage workspace → Usage
 * (`org_app_settings`, `org_settings`): a cap on the number of calls, and
 * a cap in dollars on the cost the providers report (OpenRouter's
 * `usage.cost`, DataForSEO's `cost`; a call to a provider that reports
 * none never moves it). The app is over when either is reached. With no
 * cap the counter is never read. The effective caps are cached per
 * isolate like the caller rows are, so a call costs one D1 read only when
 * a cap is set.
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
 * What a cap counts: provider calls, or the cost the providers reported
 * for them (in millionths of a US dollar, as `usage_monthly.cost_micros`).
 */
type CapKind = "calls" | "cost";

/** The cap of one kind that binds (organization, app) this month, and where it came from. */
export interface EffectiveCap {
  cap: number | null;
  source: CapSource | null;
}

/** Both caps that bind (organization, app) this month; `cost` in micro-dollars. */
export interface EffectiveCaps {
  calls: EffectiveCap;
  cost: EffectiveCap;
}

/**
 * The rule for one kind, from the organization's row on the app and its
 * default: a cap on the row wins (even next to `unlimited`, which fails
 * safe); then `unlimited` says none; then the default; then none.
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

/**
 * Both kinds, each by the rule above: an app with a dollar cap of its own
 * and no call cap of its own is held to the default call cap, and
 * `unlimited` lifts both defaults.
 */
export function effectiveMonthlyCaps(input: {
  appCap: number | null;
  appCostCap: number | null;
  unlimited: boolean;
  defaultCap: number | null;
  defaultCostCap: number | null;
}): EffectiveCaps {
  return {
    calls: effectiveMonthlyCap({
      appCap: input.appCap,
      unlimited: input.unlimited,
      defaultCap: input.defaultCap,
    }),
    cost: effectiveMonthlyCap({
      appCap: input.appCostCap,
      unlimited: input.unlimited,
      defaultCap: input.defaultCostCap,
    }),
  };
}

/** Where the caps live (OrgAppSettingsRepository in the Worker). */
interface AppCapSettings {
  /** The caps that bind the app's provider calls for the organization this month. */
  effectiveMonthlyCaps(
    organizationId: string,
    appRowId: string,
  ): Promise<EffectiveCaps>;
}

/** What (organization, app) used in a month: counted calls, and their reported cost. */
export interface MonthlyUsage {
  calls: number;
  /** Provider-reported cost in millionths of a US dollar. */
  costMicros: number;
}

/** Where the month's counts live (UsageRepository in the Worker). */
export interface MonthlyUsageCounter {
  /** Provider calls and their reported cost for (organization, app) in the UTC month "YYYY-MM". */
  monthlyUsage(
    organizationId: string,
    appRowId: string,
    month: string,
  ): Promise<MonthlyUsage>;
}

export interface AppCapSources extends AppCapSettings, MonthlyUsageCounter {}

const capCache = new Map<string, { caps: EffectiveCaps; expiresAt: number }>();

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

/** A cap of either kind binds. */
function isCapped(caps: EffectiveCaps): boolean {
  return caps.calls.cap !== null || caps.cost.cap !== null;
}

async function cachedCaps(
  settings: AppCapSettings,
  organizationId: string,
  appRowId: string,
): Promise<EffectiveCaps> {
  const key = capKey(organizationId, appRowId);
  const now = Date.now();
  const cached = capCache.get(key);
  if (cached && cached.expiresAt > now) return cached.caps;
  if (cached) capCache.delete(key);

  const caps = await settings.effectiveMonthlyCaps(organizationId, appRowId);
  capCache.set(key, {
    caps,
    expiresAt:
      now + (isCapped(caps) ? CAP_CACHE_HIT_TTL_MS : CAP_CACHE_MISS_TTL_MS),
  });
  if (capCache.size > CAP_CACHE_MAX_ENTRIES) {
    const oldest = capCache.keys().next().value;
    if (oldest) capCache.delete(oldest);
  }
  return caps;
}

/** Seconds until the UTC month `at` is in ends, at least 1. */
export function secondsUntilUtcMonthEnd(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - at.getTime()) / 1000));
}

/** One cap that binds this month, and the month's use against it. */
export interface CapStanding {
  kind: CapKind;
  /** Calls, or micro-dollars for `cost`. */
  cap: number;
  /** The month's calls, or for `cost` its reported cost in micro-dollars. */
  used: number;
  source: CapSource;
}

/** The month's standing against the caps that bind: the counts so far, and each cap. */
interface CappedMonth {
  /** "YYYY-MM" */
  month: string;
  calls: number;
  costMicros: number;
  /** The caps that bind, the call cap first; at least one. */
  caps: CapStanding[];
}

export type MonthlyCapCheck =
  | { exceeded: false; caps?: undefined }
  | ({ exceeded: false } & CappedMonth)
  | ({
      exceeded: true;
      retryAfterSeconds: number;
      /** The cap that refuses the call: the call cap when both are reached. */
      reached: CapStanding;
    } & CappedMonth);

/**
 * The standing of each kind against what binds it, the call cap first;
 * empty when nothing binds.
 */
export function capStandings(
  caps: EffectiveCaps,
  usage: MonthlyUsage,
): CapStanding[] {
  const standings: CapStanding[] = [];
  if (caps.calls.cap !== null && caps.calls.source !== null) {
    standings.push({
      kind: "calls",
      cap: caps.calls.cap,
      used: usage.calls,
      source: caps.calls.source,
    });
  }
  if (caps.cost.cap !== null && caps.cost.source !== null) {
    standings.push({
      kind: "cost",
      cap: caps.cost.cap,
      used: usage.costMicros,
      source: caps.cost.source,
    });
  }
  return standings;
}

/** The first cap the month has reached (calls before cost), or undefined. */
export function reachedCap(
  standings: readonly CapStanding[],
): CapStanding | undefined {
  return standings.find((standing) => standing.used >= standing.cap);
}

/**
 * Whether (organization, app) has used up its month: true once the month's
 * counted calls reach the call cap, or its reported cost reaches the
 * dollar cap. With no cap set the counter is never read and nothing else
 * is reported; with one, the standing comes back either way, so the
 * caller can warn at 80% (server/events/cap-events.ts), with where each
 * cap came from: the app's own row, or the organization's default.
 */
export async function checkMonthlyCap(
  sources: AppCapSources,
  organizationId: string,
  appRowId: string,
  now = new Date(),
): Promise<MonthlyCapCheck> {
  const effective = await cachedCaps(sources, organizationId, appRowId);
  if (!isCapped(effective)) return { exceeded: false };
  const month = utcMonth(now);
  const usage = await sources.monthlyUsage(organizationId, appRowId, month);
  const caps = capStandings(effective, usage);
  const standing: CappedMonth = {
    month,
    calls: usage.calls,
    costMicros: usage.costMicros,
    caps,
  };
  const reached = reachedCap(caps);
  if (!reached) return { exceeded: false, ...standing };
  return {
    exceeded: true,
    ...standing,
    reached,
    retryAfterSeconds: secondsUntilUtcMonthEnd(now),
  };
}

/**
 * What the `usage.cap_exceeded` log line says of a refusal: the cap that
 * refused (its kind, the cap, where it came from) and the month's counts.
 */
export function capExceededFields(
  check: Extract<MonthlyCapCheck, { exceeded: true }>,
): Record<string, string | number> {
  return {
    kind: check.reached.kind,
    cap: check.reached.cap,
    source: check.reached.source,
    calls: check.calls,
    costMicros: check.costMicros,
    month: check.month,
  };
}

/**
 * The alert threshold a count has reached: 100 at the cap, 80 from four
 * fifths of it (rounded up, so a cap of 1 goes straight to 100), none
 * below. The same for calls and for micro-dollars.
 */
export function capThreshold(used: number, cap: number): 100 | 80 | null {
  if (used >= cap) return 100;
  if (used >= Math.ceil(cap * 0.8)) return 80;
  return null;
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

/** A cap as the refusal says it: "1,000 provider calls", or "$20.00 of provider-reported cost". */
function capWords(standing: CapStanding): string {
  return standing.kind === "cost"
    ? `${formatUsdMicros(standing.cap)} of provider-reported cost`
    : `${standing.cap.toLocaleString("en-US")} provider calls`;
}

/**
 * What a refused call is told, at the entrypoint (the 429's body, which
 * the app's code and its OpenAI client read) and in a provider tool's
 * error (which a connected agent reads): which cap (calls or dollars),
 * where it came from, and who raises it, by role. Never a name or an
 * address: the directory goes only to apps holding the `members`
 * capability, never to agents.
 */
export function capRefusalMessage(
  name: string,
  check: { reached: CapStanding },
): string {
  const from =
    check.reached.source === "default" ? " (the workspace default)" : "";
  return `${name} has reached its monthly cap of ${capWords(check.reached)} for this organization${from}. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.`;
}
