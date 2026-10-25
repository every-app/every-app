import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./auth.schema";

/**
 * The event bus (docs/design/2026-10-events-out.md): what the gateway
 * knows about (a member joins, an app is installed, a cap is hit, a tool
 * call is blocked) as typed events, the subscriptions an owner or admin
 * made (a signed webhook, or mail to the organization's owners and
 * admins), and one delivery row per event and subscription, which is the
 * queue: the first attempt runs right after the event, the per-minute
 * cron retries what is due. Nothing here ever holds a credential, a
 * tool's arguments or result, or a mail body.
 */

/**
 * One row per subscription. `secret` is the webhook's signing secret as
 * written (the CLI writes D1 directly and has no key to wrap it with; the
 * operator's D1 is root, ADR-0003); null for the email sink, which takes
 * no address: `recipients` names a role.
 */
export const eventSubscriptions = sqliteTable(
  "event_subscriptions",
  {
    // "sub_" + 24 hex characters.
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // "webhook" | "email"
    sink: text("sink").notNull(),
    url: text("url"),
    secret: text("secret"),
    // "owners" | "admins" (owners and admins) for the email sink.
    recipients: text("recipients"),
    // JSON string[]: types or patterns ("member.*", "app.crm.*", "*").
    events: text("events").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // "cap_alerts" for the one the gateway makes with the first cap; a
    // built-in row is disabled, never deleted, so it is never recreated.
    builtin: text("builtin"),
    description: text("description"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    // A user id, "operator:<actor>" for the CLI, "agent:<connection id>".
    createdBy: text("created_by"),
    lastDeliveryAt: integer("last_delivery_at", { mode: "timestamp_ms" }),
    // "delivered" | "failed" | "dead"
    lastDeliveryStatus: text("last_delivery_status"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (table) => [
    index("event_subscriptions_organization_id_idx").on(table.organizationId),
  ],
);

/**
 * One row per event: the audit log. No foreign keys: the trail outlives
 * the app, the user and the subscription, like `mcp_tool_calls`; the
 * hourly maintenance deletes rows past AUDIT_RETENTION_DAYS (90; the
 * deliveries go after EVENT_RETENTION_DAYS, 30). `dedupe_key` makes an
 * event that must happen once (cap.warning per app, month and cap) happen
 * once across isolates: a colliding insert is dropped. `actor_kind` and
 * `actor_id` are the actor JSON's `kind` and `id` as columns, so the
 * audit log filters by who (migration 0015 backfilled them; a row written
 * before it by an older CLI may still have them null, and the readers
 * fall back to the JSON).
 */
export const events = sqliteTable(
  "events",
  {
    // "evt_" + a 26-character ULID (sorts by time).
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    type: text("type").notNull(),
    version: integer("version").notNull(),
    time: integer("time", { mode: "timestamp_ms" }).notNull(),
    // JSON: { kind, id?, email?, name? }
    actor: text("actor").notNull(),
    // "user" | "agent" | "app" | "operator" | "gateway": actor.kind as a column.
    actorKind: text("actor_kind"),
    // actor.id as a column (null for the gateway), for the audit log's filter.
    actorId: text("actor_id"),
    // JSON, at most 16 KiB (8 KiB for an app's own event).
    data: text("data").notNull(),
    appRowId: text("app_row_id"),
    dedupeKey: text("dedupe_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("events_dedupe_key_unique").on(table.dedupeKey),
    index("events_org_time_idx").on(table.organizationId, table.time),
    index("events_time_idx").on(table.time),
    index("events_org_actor_time_idx").on(
      table.organizationId,
      table.actorId,
      table.time,
    ),
  ],
);

/**
 * One row per event and subscription: the queue and the 30-day log
 * (EVENT_RETENTION_DAYS; the events themselves stay 90 days).
 * `pending` rows whose `next_attempt_at` has come are attempted by the
 * per-minute cron (and at once, after the event, under waitUntil);
 * `claimed_until` keeps two isolates off one row.
 */
export const eventDeliveries = sqliteTable(
  "event_deliveries",
  {
    // "dlv_" + 24 hex characters.
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    organizationId: text("organization_id").notNull(),
    // "pending" | "delivered" | "dead"
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
    claimedUntil: integer("claimed_until", { mode: "timestamp_ms" }),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    // The HTTP status; for the email sink, how many recipients were mailed.
    lastStatusCode: integer("last_status_code"),
    // A code ("timeout", "redirect", "status_500", "email_budget_exhausted")
    // and up to 200 characters of the answer; never the request body.
    lastError: text("last_error"),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    redeliveredAt: integer("redelivered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("event_deliveries_status_next_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("event_deliveries_subscription_created_idx").on(
      table.subscriptionId,
      table.createdAt,
    ),
    index("event_deliveries_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("event_deliveries_event_id_idx").on(table.eventId),
  ],
);
