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
  deleteExpired,
} as const;
