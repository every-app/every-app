import { and, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimitCounters } from "@/db/schema";

/** The live counts of these keys (a key without a row counts 0). */
async function read(keys: string[], now = new Date()) {
  const rows = await db
    .select({ key: rateLimitCounters.key, count: rateLimitCounters.count })
    .from(rateLimitCounters)
    .where(
      and(
        inArray(rateLimitCounters.key, keys),
        gt(rateLimitCounters.expiresAt, now),
      ),
    );
  return new Map(rows.map((row) => [row.key, row.count]));
}

/** Count one more against each key, in windows ending at `expiresAt`. */
async function increment(keys: string[], expiresAt: Date): Promise<void> {
  const [first, ...rest] = keys.map((key) =>
    db
      .insert(rateLimitCounters)
      .values({ key, count: 1, expiresAt })
      .onConflictDoUpdate({
        target: rateLimitCounters.key,
        set: { count: sql`${rateLimitCounters.count} + 1` },
      }),
  );
  if (first) await db.batch([first, ...rest]);
}

/**
 * Count one more against a key and return the new count, in one statement,
 * so concurrent callers at a limit see distinct counts (the decision rides
 * the write; a read-then-increment would let them all through).
 */
async function incrementReturning(
  key: string,
  expiresAt: Date,
): Promise<number> {
  const [row] = await db
    .insert(rateLimitCounters)
    .values({ key, count: 1, expiresAt })
    .onConflictDoUpdate({
      target: rateLimitCounters.key,
      set: { count: sql`${rateLimitCounters.count} + 1` },
    })
    .returning({ count: rateLimitCounters.count });
  return row?.count ?? 1;
}

/**
 * Claim a key once: true for the one request that writes its row, false
 * for every other, whichever isolate or location it runs in (a budget of
 * one, e.g. a single-use handoff code). The row lives until `expiresAt`,
 * which must outlast whatever the key stands for.
 */
async function claimOnce(key: string, expiresAt: Date): Promise<boolean> {
  const claimed = await db
    .insert(rateLimitCounters)
    .values({ key, count: 1, expiresAt })
    .onConflictDoNothing()
    .returning({ key: rateLimitCounters.key });
  return claimed.length === 1;
}

/** Delete counters whose window ended; returns how many. */
async function deleteExpired(now = new Date()): Promise<number> {
  const deleted = await db
    .delete(rateLimitCounters)
    .where(lte(rateLimitCounters.expiresAt, now))
    .returning({ key: rateLimitCounters.key });
  return deleted.length;
}

export const RateLimitCounterRepository = {
  read,
  increment,
  incrementReturning,
  claimOnce,
  deleteExpired,
} as const;
