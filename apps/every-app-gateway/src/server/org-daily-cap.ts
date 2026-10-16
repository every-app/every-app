/**
 * The hosted preview's per-organization daily caps on what the gateway pays
 * for (the platform policy's `orgDailyCaps`, server/platform-policy.ts):
 * requests per organization per UTC day, counted in D1
 * (`rate_limit_counters`) so they hold across isolates and locations. They
 * stand in for metering until the wallet exists. A self-hosted gateway has
 * no cap (Infinity) and never reads a counter.
 *
 * The count is read, then written for a request let through: two requests
 * at once can both pass the last slot, so a cap can run over by the
 * requests in flight. A refused request writes nothing.
 */

/** The counters' store: RateLimitCounterRepository in the Worker. */
export interface DailyCounters {
  read(keys: string[], now?: Date): Promise<Map<string, number>>;
  increment(keys: string[], expiresAt: Date): Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

type DailyCapDecision =
  | { allowed: true }
  | { allowed: false; limit: number; retryAfterSeconds: number };

/**
 * Count one request of `budget` against the organization's cap for today,
 * or refuse it once the day's are used up (with the seconds until the UTC
 * day ends). Throws when the counter can't be read or written: callers fail
 * closed.
 */
export async function spendOrgDailyCap({
  counters,
  budget,
  organizationId,
  limit,
  now = new Date(),
}: {
  counters: DailyCounters;
  /** What is counted, e.g. `ai-proxy`. */
  budget: string;
  organizationId: string;
  limit: number;
  now?: Date;
}): Promise<DailyCapDecision> {
  if (limit === Infinity) return { allowed: true };
  const day = now.toISOString().slice(0, 10);
  const dayEnds = new Date(Date.parse(day) + DAY_MS);
  const key = `org-daily:${budget}:${organizationId}:${day}`;
  const used = (await counters.read([key], now)).get(key) ?? 0;
  if (used >= limit) {
    return {
      allowed: false,
      limit,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((dayEnds.getTime() - now.getTime()) / 1000),
      ),
    };
  }
  await counters.increment([key], dayEnds);
  return { allowed: true };
}
