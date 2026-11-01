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
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { AUDIT_PAGE_MAX } from "@every-app/sdk/internal";
import { db } from "@/db";
import { eventDeliveries, events, users } from "@/db/schema";
import type { AuditCursor } from "@/types/audit";

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

interface AuditListOptions {
  organizationId: string;
  /** Rows per page, clamped to 1..AUDIT_PAGE_MAX. */
  limit: number;
  /** The page continues before this row (the previous page's `nextBefore`). */
  before?: AuditCursor | undefined;
  /** Events this actor caused (`actor_id`: a user id, a credential id, an app id, an operator). */
  actorId?: string | undefined;
  /**
   * The type filter: one type, every type under a prefix (`member.`), or
   * `null` for every type, ping and tool calls included. Undefined is the
   * default view: everything but `ping` and `tool.*`.
   */
  type?: { op: "eq" | "prefix"; value: string } | null | undefined;
  /** Rows at or after this time only. */
  since?: Date | undefined;
}

/** The row the audit readers shape: the event with its actor's current name and email. */
export interface AuditEventRow {
  id: string;
  time: Date;
  type: string;
  actor: string;
  actorKind: string | null;
  actorId: string | null;
  data: string;
  /** The user the actor is, when they are one and still have an account. */
  userEmail: string | null;
  userName: string | null;
}

/**
 * One page of an organization's events for the audit log, newest first,
 * keyset on (time, id) like the tool calls, the `events_org_time_idx` or
 * (with an actor) `events_org_actor_time_idx` index serving the range. A
 * user actor's name and email are read from `users` so the row shows what
 * they are called now; what the JSON holds is the fallback.
 */
async function listForAudit(
  options: AuditListOptions,
): Promise<{ rows: AuditEventRow[]; more: boolean }> {
  const limit = Math.min(
    Math.max(1, Math.trunc(options.limit) || 1),
    AUDIT_PAGE_MAX,
  );
  const before = options.before
    ? { time: new Date(options.before.time), id: options.before.id }
    : null;
  const typeFilter =
    options.type === undefined
      ? and(ne(events.type, "ping"), sql`${events.type} NOT LIKE 'tool.%'`)
      : options.type === null
        ? undefined
        : options.type.op === "eq"
          ? eq(events.type, options.type.value)
          : // Not LIKE: a type has underscores (mcp_app.), which LIKE would take as wildcards.
            sql`substr(${events.type}, 1, ${options.type.value.length}) = ${options.type.value}`;
  const rows = await db
    .select({
      id: events.id,
      time: events.time,
      type: events.type,
      actor: events.actor,
      actorKind: events.actorKind,
      actorId: events.actorId,
      data: events.data,
      userEmail: users.email,
      userName: users.name,
    })
    .from(events)
    .leftJoin(
      users,
      and(eq(events.actorKind, "user"), eq(users.id, events.actorId)),
    )
    .where(
      and(
        eq(events.organizationId, options.organizationId),
        before
          ? or(
              lt(events.time, before.time),
              and(eq(events.time, before.time), lt(events.id, before.id)),
            )
          : undefined,
        options.actorId ? eq(events.actorId, options.actorId) : undefined,
        typeFilter,
        options.since ? gte(events.time, options.since) : undefined,
      ),
    )
    .orderBy(desc(events.time), desc(events.id))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}

/**
 * The distinct actors of an organization's audit events (ping and tool
 * calls left out), with how many each caused, and for a user their
 * current name and email; the JSON of their latest event is the fallback.
 */
async function listAuditActors(organizationId: string): Promise<
  {
    actorKind: string | null;
    actorId: string | null;
    actor: string;
    events: number;
    userEmail: string | null;
    userName: string | null;
  }[]
> {
  return db
    .select({
      actorKind: events.actorKind,
      actorId: events.actorId,
      // SQLite's bare column with max(): the actor JSON of the latest event.
      actor: sql<string>`${events.actor}`,
      latest: sql<number>`max(${events.time})`,
      events: sql<number>`count(*)`,
      userEmail: users.email,
      userName: users.name,
    })
    .from(events)
    .leftJoin(
      users,
      and(eq(events.actorKind, "user"), eq(users.id, events.actorId)),
    )
    .where(
      and(
        eq(events.organizationId, organizationId),
        ne(events.type, "ping"),
        sql`${events.type} NOT LIKE 'tool.%'`,
      ),
    )
    .groupBy(events.actorKind, events.actorId, users.email, users.name);
}

export const EventRepository = {
  insertWithDeliveries,
  findById,
  listForAudit,
  listAuditActors,
  deleteOlderThan,
} as const;
