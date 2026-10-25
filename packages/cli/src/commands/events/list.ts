/**
 * `everyapp events list`: the organization's subscriptions, with where each
 * delivers (a URL's host and path, or whom it mails; never a secret or a
 * URL's query), what it takes, whether it is on, and how its last delivery
 * went. `everyapp events types`: the catalogue `--events` names, from the
 * CLI's own copy (`EVENT_TYPES` in `@every-app/sdk/internal`), so it needs
 * no Gateway.
 */
import { EVENT_SUBSCRIPTIONS_MAX, EVENT_TYPES } from "@every-app/sdk/internal";
import chalk from "chalk";
import { listSubscriptions, type Subscription } from "@/lib/gateway/events";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { formatTable } from "@/lib/output/table";
import { plural } from "@/lib/output/text";
import {
  connect,
  organizationData,
  patternsLabel,
  subscriptionData,
  targetOf,
  when,
  type EventsOptions,
} from "./shared";

/** The last delivery, as the list's last column says it. */
function lastDelivery(subscription: Subscription): string {
  if (subscription.lastDeliveryAt === null) return chalk.dim("never");
  const status = subscription.lastDeliveryStatus ?? "unknown";
  const colored =
    status === "delivered" ? chalk.green(status) : status === "dead" ? chalk.red(status) : chalk.yellow(status);
  const failures =
    subscription.consecutiveFailures > 0
      ? chalk.yellow(` · ${plural(subscription.consecutiveFailures, "failure")} in a row`)
      : "";
  return `${colored} ${when(subscription.lastDeliveryAt)}${failures}`;
}

export async function listEvents(options: EventsOptions): Promise<void> {
  const { out } = options;
  const { gateway, organization } = await connect(options);
  const subscriptions = await listSubscriptions(gateway.db, organization.id);
  const summary = `${plural(subscriptions.length, "subscription")} in ${organization.name} (at most ${EVENT_SUBSCRIPTIONS_MAX})`;
  const display =
    subscriptions.length === 0
      ? [
          chalk.dim(`${organization.name} has no event subscriptions.`),
          chalk.dim(`Add a webhook: ${CLI} events add https://hooks.example.com/everyapp --events member.*`),
          chalk.dim(`Or mail the owners and admins: ${CLI} events add --email admins --events cap.*`),
        ]
      : [
          ...formatTable(
            ["ID", "NAME", "TARGET", "EVENTS", "ON", "LAST DELIVERY"],
            subscriptions.map((subscription) => [
              subscription.id,
              `${subscription.name}${subscription.builtin ? chalk.dim(" (built-in)") : ""}`,
              targetOf(subscription),
              patternsLabel(subscription.events),
              subscription.enabled ? chalk.green("on") : chalk.dim("off"),
              lastDelivery(subscription),
            ]),
          ),
          "",
          chalk.dim(summary),
        ];
  out.emit({
    type: "done",
    message: summary,
    display: display.join("\n"),
    data: {
      organization: organizationData(organization),
      subscriptions: subscriptions.map(subscriptionData),
      max: EVENT_SUBSCRIPTIONS_MAX,
    },
  });
}

/** `events types`: the catalogue, then how patterns and an app's own events read. */
export function listTypes({ out }: { out: EventSink }): void {
  const notes = [
    "An app's own events are app.<app id>.<name> (app.crm.invoice.paid): subscribe with app.crm.* or app.*.",
    "--events takes types, prefixes with .* (member.*), or * for everything but test pings (the default).",
  ];
  out.emit({
    type: "done",
    message: `${plural(EVENT_TYPES.length, "event type")}`,
    display: [
      ...formatTable(
        ["TYPE", "V", "WHAT"],
        EVENT_TYPES.map((info) => [info.type, String(info.version), chalk.dim(info.description)]),
      ),
      "",
      ...notes.map((note) => chalk.dim(note)),
    ].join("\n"),
    data: {
      types: EVENT_TYPES.map((info) => ({
        type: info.type,
        version: info.version,
        group: info.group,
        description: info.description,
      })),
      patterns: ["*", "<group>.*", "app.<app id>.*", "app.<app id>.<name>"],
    },
  });
}
