/**
 * The `event_subscriptions` table (db/events.schema.ts): an owner's or
 * admin's webhook or email subscriptions, read and written under their
 * organization only. The listing shape leaves the signing secret out, so
 * no surface that lists subscriptions can show it again; only the
 * delivery path reads a row with its secret ({@link findForDelivery}).
 */
import { and, asc, count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { eventSubscriptions } from "@/db/schema";

export type SubscriptionRow = typeof eventSubscriptions.$inferSelect;

/** A subscription as every list and page sees it: never the secret. */
export type ListedSubscription = Omit<SubscriptionRow, "secret">;

const listedColumns = {
  id: eventSubscriptions.id,
  organizationId: eventSubscriptions.organizationId,
  name: eventSubscriptions.name,
  sink: eventSubscriptions.sink,
  url: eventSubscriptions.url,
  recipients: eventSubscriptions.recipients,
  events: eventSubscriptions.events,
  enabled: eventSubscriptions.enabled,
  builtin: eventSubscriptions.builtin,
  description: eventSubscriptions.description,
  createdAt: eventSubscriptions.createdAt,
  updatedAt: eventSubscriptions.updatedAt,
  createdBy: eventSubscriptions.createdBy,
  lastDeliveryAt: eventSubscriptions.lastDeliveryAt,
  lastDeliveryStatus: eventSubscriptions.lastDeliveryStatus,
  consecutiveFailures: eventSubscriptions.consecutiveFailures,
};

/** The organization's subscriptions, oldest first, secrets left out. */
async function listByOrganization(
  organizationId: string,
): Promise<ListedSubscription[]> {
  return db
    .select(listedColumns)
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.organizationId, organizationId))
    .orderBy(asc(eventSubscriptions.createdAt), asc(eventSubscriptions.id));
}

async function findById(
  id: string,
  organizationId: string,
): Promise<ListedSubscription | null> {
  const [row] = await db
    .select(listedColumns)
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, id),
        eq(eventSubscriptions.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The row with its secret, for signing a delivery; organization-scoped. */
async function findForDelivery(
  id: string,
  organizationId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, id),
        eq(eventSubscriptions.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The organization's built-in subscription of a kind, if it has one. */
async function findBuiltin(
  organizationId: string,
  builtin: string,
): Promise<ListedSubscription | null> {
  const [row] = await db
    .select(listedColumns)
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.organizationId, organizationId),
        eq(eventSubscriptions.builtin, builtin),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function countByOrganization(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.organizationId, organizationId));
  return row?.value ?? 0;
}

async function insert(row: typeof eventSubscriptions.$inferInsert) {
  await db.insert(eventSubscriptions).values(row);
}

type SubscriptionPatch = Partial<
  Pick<SubscriptionRow, "name" | "events" | "enabled" | "description">
>;

/** Change a subscription's name, events, switch or description; false when it isn't the organization's. */
async function update(
  id: string,
  organizationId: string,
  patch: SubscriptionPatch,
  now = new Date(),
): Promise<boolean> {
  const updated = await db
    .update(eventSubscriptions)
    .set({ ...patch, updatedAt: now })
    .where(
      and(
        eq(eventSubscriptions.id, id),
        eq(eventSubscriptions.organizationId, organizationId),
      ),
    )
    .returning({ id: eventSubscriptions.id });
  return updated.length > 0;
}

async function deleteById(
  id: string,
  organizationId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.id, id),
        eq(eventSubscriptions.organizationId, organizationId),
      ),
    )
    .returning({ id: eventSubscriptions.id });
  return deleted.length > 0;
}

/**
 * Note an attempt's outcome on the subscription: the time and status of
 * the last attempt on any of its deliveries, and the failures in a row
 * (reset by a delivered attempt), which the Events tab shows.
 */
async function recordAttempt(
  id: string,
  outcome: { at: Date; status: "delivered" | "failed" | "dead" },
): Promise<void> {
  await db
    .update(eventSubscriptions)
    .set({
      lastDeliveryAt: outcome.at,
      lastDeliveryStatus: outcome.status,
      consecutiveFailures:
        outcome.status === "delivered"
          ? 0
          : sql`${eventSubscriptions.consecutiveFailures} + 1`,
    })
    .where(eq(eventSubscriptions.id, id));
}

export const EventSubscriptionRepository = {
  listByOrganization,
  findById,
  findForDelivery,
  findBuiltin,
  countByOrganization,
  insert,
  update,
  deleteById,
  recordAttempt,
} as const;
