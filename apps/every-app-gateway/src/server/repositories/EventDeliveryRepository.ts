/**
 * The `event_deliveries` table (db/events.schema.ts): the queue and the
 * 30-day log, one row per event and subscription. A worker takes a row
 * with one conditional UPDATE ({@link claim}) that bumps the attempt count
 * and holds the row for a minute, so two isolates (a request's waitUntil
 * and the cron's sweep) never send the same attempt; the outcome writes
 * put it back as pending with a next attempt time, or settle it. Reads
 * for a page are organization-scoped and keyset-paged on (created_at, id).
 */
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { eventDeliveries, events } from "@/db/schema";

export type DeliveryRow = typeof eventDeliveries.$inferSelect;
export type DeliveryStatus = "pending" | "delivered" | "dead";

const PRUNE_BATCH_SIZE = 1000;
const PRUNE_MAX_BATCHES = 10;

/**
 * Take the row for one attempt: only a pending row nobody holds. The
 * claim bumps `attempts` and notes the attempt time, and holds the row
 * for `holdMs`. Null when another worker has it or it is settled.
 */
async function claim(
  id: string,
  now: Date,
  holdMs: number,
): Promise<DeliveryRow | null> {
  const [row] = await db
    .update(eventDeliveries)
    .set({
      claimedUntil: new Date(now.getTime() + holdMs),
      attempts: sql`${eventDeliveries.attempts} + 1`,
      lastAttemptAt: now,
    })
    .where(
      and(
        eq(eventDeliveries.id, id),
        eq(eventDeliveries.status, "pending"),
        or(
          isNull(eventDeliveries.claimedUntil),
          lt(eventDeliveries.claimedUntil, now),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

async function findById(
  id: string,
  organizationId: string,
): Promise<DeliveryRow | null> {
  const [row] = await db
    .select()
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.id, id),
        eq(eventDeliveries.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Pending rows whose time has come and nobody holds, soonest first. */
async function findDue(now: Date, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: eventDeliveries.id })
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.status, "pending"),
        lte(eventDeliveries.nextAttemptAt, now),
        or(
          isNull(eventDeliveries.claimedUntil),
          lt(eventDeliveries.claimedUntil, now),
        ),
      ),
    )
    .orderBy(eventDeliveries.nextAttemptAt, eventDeliveries.id)
    .limit(limit);
  return rows.map((row) => row.id);
}

async function markDelivered(
  id: string,
  outcome: { at: Date; statusCode: number | null },
): Promise<void> {
  await db
    .update(eventDeliveries)
    .set({
      status: "delivered",
      deliveredAt: outcome.at,
      nextAttemptAt: null,
      claimedUntil: null,
      lastStatusCode: outcome.statusCode,
      lastError: null,
    })
    .where(eq(eventDeliveries.id, id));
}

/** Put a failed attempt back in the queue for `nextAttemptAt`. */
async function markRetry(
  id: string,
  outcome: { nextAttemptAt: Date; statusCode: number | null; error: string },
): Promise<void> {
  await db
    .update(eventDeliveries)
    .set({
      status: "pending",
      nextAttemptAt: outcome.nextAttemptAt,
      claimedUntil: null,
      lastStatusCode: outcome.statusCode,
      lastError: outcome.error,
    })
    .where(eq(eventDeliveries.id, id));
}

async function markDead(
  id: string,
  outcome: { statusCode: number | null; error: string },
): Promise<void> {
  await db
    .update(eventDeliveries)
    .set({
      status: "dead",
      nextAttemptAt: null,
      claimedUntil: null,
      lastStatusCode: outcome.statusCode,
      lastError: outcome.error,
    })
    .where(eq(eventDeliveries.id, id));
}

/**
 * Queue a failed or dead delivery again by hand: pending, due now, the
 * attempt count starting over so it gets the full schedule. False when
 * the row isn't the organization's or is already delivered.
 */
async function resetForRedelivery(
  id: string,
  organizationId: string,
  now: Date,
): Promise<boolean> {
  const reset = await db
    .update(eventDeliveries)
    .set({
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
      claimedUntil: null,
      redeliveredAt: now,
    })
    .where(
      and(
        eq(eventDeliveries.id, id),
        eq(eventDeliveries.organizationId, organizationId),
        inArray(eventDeliveries.status, ["pending", "dead"]),
      ),
    )
    .returning({ id: eventDeliveries.id });
  return reset.length > 0;
}

interface DeliveryPageQuery {
  subscriptionId?: string;
  status?: DeliveryStatus;
  /** The last row of the previous page: `<created_at ms>:<id>`. */
  before?: string;
  limit: number;
}

export type ListedDelivery = DeliveryRow & {
  event: {
    id: string;
    type: string;
    version: number;
    time: Date;
    actor: string;
    data: string;
    appRowId: string | null;
  } | null;
};

const eventColumns = {
  id: events.id,
  type: events.type,
  version: events.version,
  time: events.time,
  actor: events.actor,
  data: events.data,
  appRowId: events.appRowId,
};

/** Parse a page cursor; null for anything that isn't one. */
function parseCursor(before: string | undefined) {
  if (!before) return null;
  const separator = before.indexOf(":");
  if (separator === -1) return null;
  const createdAt = Number(before.slice(0, separator));
  const id = before.slice(separator + 1);
  return Number.isFinite(createdAt) && id ? { createdAt, id } : null;
}

/** The cursor that continues a page after this row. */
export function deliveryCursor(row: Pick<DeliveryRow, "createdAt" | "id">) {
  return `${row.createdAt.getTime()}:${row.id}`;
}

/** One delivery with its event, organization-scoped. */
async function findListedById(
  id: string,
  organizationId: string,
): Promise<ListedDelivery | null> {
  const [row] = await db
    .select({ delivery: eventDeliveries, event: eventColumns })
    .from(eventDeliveries)
    .leftJoin(events, eq(events.id, eventDeliveries.eventId))
    .where(
      and(
        eq(eventDeliveries.id, id),
        eq(eventDeliveries.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ? { ...row.delivery, event: row.event } : null;
}

/** The organization's deliveries, newest first, with each one's event. */
async function listForOrganization(
  organizationId: string,
  query: DeliveryPageQuery,
): Promise<ListedDelivery[]> {
  const cursor = parseCursor(query.before);
  const rows = await db
    .select({ delivery: eventDeliveries, event: eventColumns })
    .from(eventDeliveries)
    .leftJoin(events, eq(events.id, eventDeliveries.eventId))
    .where(
      and(
        eq(eventDeliveries.organizationId, organizationId),
        ...(query.subscriptionId
          ? [eq(eventDeliveries.subscriptionId, query.subscriptionId)]
          : []),
        ...(query.status ? [eq(eventDeliveries.status, query.status)] : []),
        ...(cursor
          ? [
              or(
                lt(eventDeliveries.createdAt, new Date(cursor.createdAt)),
                and(
                  eq(eventDeliveries.createdAt, new Date(cursor.createdAt)),
                  lt(eventDeliveries.id, cursor.id),
                ),
              ),
            ]
          : []),
      ),
    )
    .orderBy(desc(eventDeliveries.createdAt), desc(eventDeliveries.id))
    .limit(query.limit);
  return rows.map(({ delivery, event }) => ({ ...delivery, event }));
}

async function deleteOlderThan(
  cutoff: Date,
  maxBatches = PRUNE_MAX_BATCHES,
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db
      .delete(eventDeliveries)
      .where(
        inArray(
          eventDeliveries.id,
          db
            .select({ id: eventDeliveries.id })
            .from(eventDeliveries)
            .where(lt(eventDeliveries.createdAt, cutoff))
            .limit(PRUNE_BATCH_SIZE),
        ),
      )
      .returning({ id: eventDeliveries.id });
    deleted += result.length;
    if (result.length < PRUNE_BATCH_SIZE) return { deleted, done: true };
  }
  return { deleted, done: false };
}

export const EventDeliveryRepository = {
  claim,
  findById,
  findDue,
  markDelivered,
  markRetry,
  markDead,
  resetForRedelivery,
  findListedById,
  listForOrganization,
  deleteOlderThan,
} as const;
