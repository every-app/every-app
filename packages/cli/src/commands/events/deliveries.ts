/**
 * `everyapp events deliveries [<subscription id>]`: the organization's last
 * deliveries (30 days), newest first, of one subscription or all, dead ones
 * only with `--dead`: what was sent, to which subscription, how many
 * attempts, how it went, and when the next attempt is. `everyapp events
 * redeliver <delivery id>`: send a pending or dead one again (pending, due
 * now, attempts back to 0); the Gateway's per-minute sweep sends it, with
 * the full retry schedule. A delivered one is left alone.
 */
import chalk from "chalk";
import { DELIVERIES_LIMIT_MAX, findSubscription, listDeliveries, redeliver, type Delivery } from "@/lib/gateway/events";
import { CLI } from "@/lib/output/command";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import {
  connect,
  deliveryData,
  organizationData,
  stateLabel,
  when,
  type EventsFlags,
  type EventsOptions,
} from "./shared";

export interface DeliveriesFlags extends EventsFlags {
  dead?: boolean;
  limit?: number;
}

/** How many deliveries `--limit` shows when not given. */
const DELIVERIES_LIMIT_DEFAULT = 20;

/** `--limit`: a whole number from 1 to 200. */
export function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > DELIVERIES_LIMIT_MAX) {
    throw new Error(`Use a whole number from 1 to ${DELIVERIES_LIMIT_MAX}.`);
  }
  return limit;
}

/** A failed attempt's error as a table cell: its first line, short. */
const errorCell = (delivery: Delivery) => {
  const error = delivery.lastError?.split("\n")[0];
  if (!error) return "";
  return chalk.dim(error.length > 60 ? `${error.slice(0, 59)}…` : error);
};

export async function listDeliveriesOf(
  options: EventsOptions<DeliveriesFlags>,
  subscriptionId?: string,
): Promise<void> {
  const { out, flags } = options;
  const { gateway, organization } = await connect(options);
  const now = options.now?.() ?? Date.now();
  // One of another organization's, or a mistyped id, is refused rather than listed as empty.
  const subscription = subscriptionId ? await findSubscription(gateway.db, organization, subscriptionId) : null;
  const deliveries = await listDeliveries(gateway.db, {
    organizationId: organization.id,
    ...(subscription ? { subscriptionId: subscription.id } : {}),
    dead: flags.dead ?? false,
    limit: flags.limit ?? DELIVERIES_LIMIT_DEFAULT,
    now,
  });
  const of = subscription ? ` to ${subscription.name}` : "";
  const dead = flags.dead ? "dead " : "";
  const summary =
    deliveries.length === 0
      ? `No ${dead}deliveries${of} in the last 30 days`
      : deliveries.length === 1
        ? `The last ${dead}delivery${of}`
        : `The last ${deliveries.length} ${dead}deliveries${of}`;
  const redeliverable = deliveries.filter((delivery) => delivery.status === "dead");
  out.emit({
    type: "done",
    message: summary,
    display: [
      ...(deliveries.length === 0
        ? [chalk.dim(`${summary}.`)]
        : [
            ...formatTable(
              ["WHEN", "DELIVERY", "EVENT", "TO", "STATUS", "TRIES", "NEXT", "LAST ERROR"],
              deliveries.map((delivery) => [
                when(delivery.createdAt),
                delivery.id,
                delivery.type ?? chalk.dim("(expired)"),
                delivery.subscriptionName ?? chalk.dim(delivery.subscriptionId),
                stateLabel(delivery, now),
                String(delivery.attempts),
                delivery.status === "pending" && delivery.nextAttemptAt !== null ? when(delivery.nextAttemptAt) : "",
                errorCell(delivery),
              ]),
            ),
            ...(redeliverable.length > 0
              ? ["", chalk.dim(`Send a dead one again: ${CLI} events redeliver <delivery>`)]
              : []),
          ]),
    ].join("\n"),
    data: {
      organization: organizationData(organization),
      subscriptionId: subscription?.id ?? null,
      dead: flags.dead ?? false,
      deliveries: deliveries.map((delivery) => deliveryData(delivery, now)),
    },
  });
}

export async function redeliverOne(options: EventsOptions, id: string): Promise<void> {
  const { out } = options;
  const { gateway, organization } = await connect(options);
  const now = options.now?.() ?? Date.now();
  const { delivery, previous, outcome } = await redeliver(gateway.db, organization, id, now);
  const what = `${previous.type ?? "the event"} to ${previous.subscriptionName ?? previous.subscriptionId}`;
  const was =
    previous.status === "dead"
      ? `it was dead after ${plural(previous.attempts, "attempt")}`
      : `it was ${previous.attempts > 0 ? "failing" : "queued"}`;
  const headline =
    outcome === "attempting"
      ? `${previous.id} is being sent right now. Nothing changed.`
      : outcome === "delivered"
        ? `${previous.id} was already delivered (${what}). Nothing changed.`
        : `Queued ${previous.id} again (${what}; ${was}).`;
  const note =
    outcome === "queued"
      ? "The Gateway sends it within a minute, with the full retry schedule."
      : `See how it went: ${CLI} events deliveries ${previous.subscriptionId}`;
  out.emit({
    type: "done",
    message: `${headline} ${note}`,
    display: [headline, chalk.dim(note)].join("\n"),
    data: {
      outcome,
      delivery: deliveryData(delivery, now),
      previousStatus: previous.status,
      organization: organizationData(organization),
    },
  });
}
