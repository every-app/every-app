import type { EventEmailRecipients } from "@every-app/sdk/internal";

/**
 * The event bus as Manage workspace → Events shows it (docs/design/
 * 2026-10-events-out.md, section 10): a subscription with how its last
 * delivery went, and one delivery with the event it carried. The
 * subscriptions service (server/events/subscriptions.ts) answers in these
 * shapes, for the page and later the admin MCP tools alike. A
 * subscription's signing secret is never one of the fields: it is shown
 * once, in the answer that generated it, and nowhere after.
 */

/** Plain JSON, as a server function may return it. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** How a subscription's last attempt went: a failed one is retried, a dead one is not. */
export type EventLastDeliveryStatus = "delivered" | "failed" | "dead";

/** A subscription as the Events tab lists it. */
export type EventSubscription = {
  id: string;
  name: string;
  sink: "webhook" | "email";
  /** The webhook's URL as stored; null for the email sink. */
  url: string | null;
  /** Whom the email sink mails; null for a webhook. */
  recipients: EventEmailRecipients | null;
  /** Types and patterns (`member.*`, `app.crm.*`); `["*"]` is everything. */
  events: string[];
  enabled: boolean;
  /** `cap_alerts` for the one the first cap creates; removing it turns it off. */
  builtin: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: EventLastDeliveryStatus | null;
  /** Failed attempts in a row; a delivered one resets it. */
  consecutiveFailures: number;
};

/** A delivery row's stored status; a pending one with an error reads as failed. */
type EventDeliveryStatus = "pending" | "delivered" | "dead";

/** The event a delivery carried, as the envelope has it (never anything secret, by construction). */
export type EventDeliveryEvent = {
  id: string;
  type: string;
  version: number;
  summary: string;
  time: string;
  actor: { [key: string]: JsonValue } | null;
  data: { [key: string]: JsonValue };
  appRowId: string | null;
};

/** One delivery of one event to one subscription. */
export type EventDelivery = {
  id: string;
  subscriptionId: string;
  status: EventDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  /** The HTTP status; for the email sink, how many people were mailed. */
  lastStatusCode: number | null;
  /** A code (`timeout`, `status_500`, `email_not_configured`) and the start of the answer. */
  lastError: string | null;
  deliveredAt: string | null;
  redeliveredAt: string | null;
  createdAt: string;
  /** Null once the event is past its 30 days. */
  event: EventDeliveryEvent | null;
};
