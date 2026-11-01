/**
 * What every `everyapp events …` handler shares: the flags, the seams tests
 * use, the connection (the Gateway through the Cloudflare login, the event
 * tables, GATEWAY_OUTDATED without them, and the organization `--org`
 * names or the install one, resolved as `workspace` resolves it), and how
 * subscriptions and deliveries are said, to a person in a table and to a
 * script in `data`. A subscription's secret is never among them.
 */
import chalk from "chalk";
import type { CfRunner } from "@/lib/cf/runner";
import { connectToGateway, requestedGatewayUrl } from "@/lib/gateway/connect";
import { shownTarget } from "@/lib/gateway/eventTarget";
import { deliveryState, requireEventsTables, type Delivery, type Subscription } from "@/lib/gateway/events";
import type { Organization } from "@/lib/gateway/registry";
import { organizationFor } from "@/lib/gateway/workspace";
import type { EventSink } from "@/lib/output/events";
import { canPromptInTerminal } from "@/lib/output/prompt";
import type { OrganizationCommandFlags } from "../flags";

/** The flags every events command takes. */
export type EventsFlags = OrganizationCommandFlags;

/** What the handlers take from the command line, and the seams tests use. */
export interface EventsOptions<F extends EventsFlags = EventsFlags> {
  flags: F;
  out: EventSink;
  /** cf per account (tests). */
  createCf?: (accountId?: string) => CfRunner;
  now?: () => number;
}

type Gateway = Awaited<ReturnType<typeof connectToGateway>>;

/** The Gateway (through the login), the organization the command acts on, and its event tables. */
export async function connect(options: EventsOptions): Promise<{ gateway: Gateway; organization: Organization }> {
  const { flags, out, createCf } = options;
  const gateway = await connectToGateway({
    gateway: requestedGatewayUrl(flags.gateway),
    accountId: flags["account-id"],
    interactive: canPromptInTerminal(flags.json ?? false),
    login: { json: flags.json, out, step: "login" },
    createCf,
  });
  await requireEventsTables(gateway.db);
  const organization = await organizationFor(gateway.db, flags.org);
  return { gateway, organization };
}

/** A time as a person reads it in a table: "2026-10-25 09:15". */
export function when(ms: number | null): string {
  if (ms === null) return chalk.dim("never");
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/** A time for `data`: ISO, or null. */
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Where a subscription delivers, as a person reads it: a URL's host and path, or whom it mails. */
export function targetOf(subscription: Pick<Subscription, "sink" | "url" | "recipients">): string {
  if (subscription.sink === "email") {
    return subscription.recipients === "owners" ? "email → owners" : "email → owners and admins";
  }
  return subscription.url ? shownTarget(subscription.url) : "(no URL)";
}

/** A subscription's patterns as a person reads them: "everything" for `*`. */
export function patternsLabel(patterns: readonly string[]): string {
  return patterns.includes("*") ? "everything" : patterns.join(", ");
}

/** A subscription for `data`: what every command says about one, never its secret or a URL's query. */
export function subscriptionData(subscription: Subscription) {
  return {
    id: subscription.id,
    name: subscription.name,
    sink: subscription.sink,
    target: targetOf(subscription),
    recipients: subscription.recipients,
    events: subscription.events,
    enabled: subscription.enabled,
    builtin: subscription.builtin,
    createdAt: iso(subscription.createdAt),
    createdBy: subscription.createdBy,
    lastDeliveryAt: iso(subscription.lastDeliveryAt),
    lastDeliveryStatus: subscription.lastDeliveryStatus,
    consecutiveFailures: subscription.consecutiveFailures,
  };
}

/** A subscription as a sentence names it: "Slack #ops (sub_…)". */
export const named = (subscription: Pick<Subscription, "id" | "name">) =>
  `${subscription.name} (${subscription.id})`;

/** A delivery's state as a person reads it, colored. */
export function stateLabel(delivery: Delivery, now: number): string {
  const state = deliveryState(delivery, now);
  const answered = delivery.lastStatusCode !== null && delivery.lastStatusCode > 0 ? delivery.lastStatusCode : null;
  // The email sink stores the number of recipients mailed where a webhook's status code goes.
  const code = answered === null ? "" : delivery.sink === "email" ? `, ${answered} mailed` : ` ${answered}`;
  switch (state) {
    case "delivered":
      return chalk.green(`delivered${code}`);
    case "dead":
      return chalk.red("dead");
    case "failed":
      return chalk.yellow(`failed${code}, retrying`);
    default:
      return chalk.dim(delivery.attempts > 0 ? "sending" : "queued");
  }
}

/** A delivery for `data`. */
export function deliveryData(delivery: Delivery, now: number) {
  return {
    id: delivery.id,
    eventId: delivery.eventId,
    type: delivery.type,
    subscriptionId: delivery.subscriptionId,
    subscriptionName: delivery.subscriptionName,
    sink: delivery.sink,
    status: delivery.status,
    state: deliveryState(delivery, now),
    attempts: delivery.attempts,
    lastStatusCode: delivery.lastStatusCode,
    lastError: delivery.lastError,
    nextAttemptAt: iso(delivery.nextAttemptAt),
    lastAttemptAt: iso(delivery.lastAttemptAt),
    deliveredAt: iso(delivery.deliveredAt),
    redeliveredAt: iso(delivery.redeliveredAt),
    createdAt: iso(delivery.createdAt),
  };
}

/** An organization for `data`. */
export const organizationData = (organization: Organization) => ({
  id: organization.id,
  name: organization.name,
  slug: organization.slug,
});
