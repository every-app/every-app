/**
 * The `events` table (db/events.schema.ts): one row per event, written
 * together with its delivery rows in one D1 batch so an event is never
 * queued half-way. The dedupe key makes an event that must happen once
 * happen once across isolates: the event insert does nothing on a
 * collision, and the delivery inserts are `INSERT ... SELECT ... WHERE`
 * the event row exists, so a dropped event queues no deliveries either.
 * Rows outlive the app, the user and the subscription (no foreign keys)
 * and are pruned by age from the hourly maintenance.
 */
import {
  and,
  eq,
  getTableColumns,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/db";
import { eventDeliveries, events } from "@/db/schema";

type EventRow = typeof events.$inferSelect;
type NewEventRow = typeof events.$inferInsert;
type NewDeliveryRow = typeof eventDeliveries.$inferInsert;

/** Rows deleted per statement, and statements per run, when pruning. */
const PRUNE_BATCH_SIZE = 1000;
const PRUNE_MAX_BATCHES = 10;

/** A column's value as the insert binds it: dates as milliseconds. */
function bound(value: unknown): SQL {
  if (value instanceof Date) return sql`${value.getTime()}`;
  if (value === undefined) return sql`null`;
  return sql`${value}`;
}

type DeliverySelection = {
  [K in keyof NewDeliveryRow]-?: SQL.Aliased<unknown>;
};

/**
 * `INSERT INTO event_deliveries SELECT <the row> FROM events WHERE id = ?`:
 * drizzle's insert-select lists every table column in definition order,
 * so the selection is built from the columns map in that same order.
 */
function conditionalDeliveryInsert(row: NewDeliveryRow, eventId: string) {
  const selection = Object.fromEntries(
    Object.keys(getTableColumns(eventDeliveries)).map((key) => [
      key,
      bound((row as Record<string, unknown>)[key]).as(key),
    ]),
  ) as DeliverySelection;
  return db
    .insert(eventDeliveries)
    .select(db.select(selection).from(events).where(eq(events.id, eventId)))
    .returning({ id: eventDeliveries.id });
}

/**
 * Write the event and its deliveries atomically. `inserted` is false when
 * the dedupe key collided: nothing was written, and nothing is delivered.
 */
async function insertWithDeliveries(
  event: NewEventRow,
  deliveries: NewDeliveryRow[],
): Promise<{ inserted: boolean; deliveryIds: string[] }> {
  const [inserted, ...queued] = await db.batch([
    db
      .insert(events)
      .values(event)
      .onConflictDoNothing({ target: events.dedupeKey })
      .returning({ id: events.id }),
    ...deliveries.map((row) => conditionalDeliveryInsert(row, event.id)),
  ]);
  return {
    inserted: inserted.length > 0,
    deliveryIds: queued.flatMap((rows) => rows.map((row) => row.id)),
  };
}

async function findById(
  id: string,
  organizationId: string,
): Promise<EventRow | null> {
  const [row] = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/**
 * Delete events that happened before `cutoff`, in bounded batches;
 * returns how many went, and whether the run got through them all.
 */
async function deleteOlderThan(
  cutoff: Date,
  maxBatches = PRUNE_MAX_BATCHES,
): Promise<{ deleted: number; done: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await db
      .delete(events)
      .where(
        inArray(
          events.id,
          db
            .select({ id: events.id })
            .from(events)
            .where(lt(events.time, cutoff))
            .limit(PRUNE_BATCH_SIZE),
        ),
      )
      .returning({ id: events.id });
    deleted += result.length;
    if (result.length < PRUNE_BATCH_SIZE) return { deleted, done: true };
  }
  return { deleted, done: false };
}

export const EventRepository = {
  insertWithDeliveries,
  findById,
  deleteOlderThan,
} as const;
