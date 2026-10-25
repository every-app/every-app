/**
 * `everyapp events remove|enable|disable <id>`: one subscription of the
 * organization, by id (`events list` names them). A built-in one (the
 * Gateway's cap alerts) is disabled when removed, so the Gateway never
 * makes it again behind the person's back; the output says so. Each is
 * safe to repeat: a subscription that is off already stays off.
 */
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { removeSubscription, setSubscriptionEnabled } from "@/lib/gateway/events";
import { CLI } from "@/lib/output/command";
import { connect, named, organizationData, subscriptionData, type EventsOptions } from "./shared";

export async function removeEvents(options: EventsOptions, id: string): Promise<void> {
  const { out } = options;
  const { gateway, organization } = await connect(options);
  const { subscription, outcome } = await removeSubscription(gateway.db, organization, id, options.now?.());
  const lines =
    outcome === "disabled"
      ? [
          `${named(subscription)} is built in, so it was disabled instead of removed.`,
          `The Gateway won't make it again. Turn it back on: ${CLI} events enable ${subscription.id}`,
        ]
      : [
          `Removed ${named(subscription)} from ${organization.name}.`,
          "Nothing more is delivered to it; its delivery log stays for 30 days.",
        ];
  out.emit({
    type: "done",
    message: lines.join(" "),
    display: [lines[0], chalk.dim(lines[1]!)].join("\n"),
    data: {
      id: subscription.id,
      outcome,
      subscription: subscriptionData(subscription),
      organization: organizationData(organization),
    },
  });
}

export async function setEnabled(options: EventsOptions, id: string, enabled: boolean): Promise<void> {
  const { out } = options;
  const { gateway, organization } = await connect(options);
  const { subscription, changed } = await setSubscriptionEnabled(
    gateway.db,
    organization,
    id,
    enabled,
    options.now?.(),
  );
  const headline = changed
    ? `${enabled ? "Enabled" : "Disabled"} ${named(subscription)}.`
    : `${named(subscription)} is ${enabled ? "enabled" : "disabled"} already.`;
  const note = !changed
    ? "Nothing changed."
    : enabled
      ? "New events are queued for it again; what happened while it was off isn't sent."
      : "No new events are queued for it, and the Gateway drops what is queued.";
  out.emit({
    type: "done",
    message: stripVTControlCharacters(`${headline} ${note}`),
    display: [headline, chalk.dim(note)].join("\n"),
    data: {
      id: subscription.id,
      enabled,
      changed,
      subscription: subscriptionData(subscription),
      organization: organizationData(organization),
    },
  });
}
