/**
 * What Manage workspace → Events says about subscriptions and deliveries,
 * in one place the table, the Add dialog, the deliveries sheet and their
 * tests read (docs/design/2026-10-events-out.md, section 10): where a
 * subscription delivers (a URL's host and path, never its query, where a
 * hook's own token often rides; or whom it mails), its patterns as a
 * person reads them, a delivery's state (a pending delivery that failed
 * reads Failed until its next attempt settles it), its last error in
 * plain words, the envelope the receiver got, and the catalogue grouped
 * for the Add dialog's checkboxes. Pure functions and strings only.
 */
import {
  eventPatternProblem,
  type EventGroup,
  type EventTypeInfo,
} from "@every-app/sdk/internal";
import type {
  EventDelivery,
  EventDeliveryEvent,
  EventSubscription,
  JsonValue,
} from "@/types/events";

/** The person's page on events: what they are, the Slack and Zapier recipes, verifying. */
export const EVENTS_DOCS_URL = "https://everyapp.com/docs/events";

/** The same thing from a terminal, as the empty state offers it. */
export const EVENTS_CLI_LINE = "pnpm everyapp events add <url>";

/** The pattern that takes every event but a test ping. */
export const EVERYTHING = "*";

/** Where a subscription delivers, as a person reads it. */
export function subscriptionTarget(
  subscription: Pick<EventSubscription, "sink" | "url" | "recipients">,
): string {
  if (subscription.sink === "email") {
    return subscription.recipients === "owners"
      ? "Email → owners"
      : "Email → owners and admins";
  }
  return webhookTarget(subscription.url);
}

/** A webhook URL's host and path: no scheme for https, no query, no fragment. */
function webhookTarget(url: string | null): string {
  if (!url) return "No URL";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const scheme = parsed.protocol === "https:" ? "" : `${parsed.protocol}//`;
    return `${scheme}${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** True when the patterns take everything. */
export function isEverything(patterns: readonly string[]): boolean {
  return patterns.includes(EVERYTHING);
}

/** What a delivery is now: a pending one that has failed is Failed until it is retried. */
export type DeliveryState = "delivered" | "failed" | "dead" | "pending";

export function deliveryState(
  delivery: Pick<EventDelivery, "status" | "attempts" | "lastError">,
): DeliveryState {
  if (delivery.status === "delivered" || delivery.status === "dead") {
    return delivery.status;
  }
  return delivery.attempts > 0 && delivery.lastError ? "failed" : "pending";
}

/** The label of a state, on a badge. */
export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  delivered: "Delivered",
  failed: "Failed",
  dead: "Dead",
  pending: "Queued",
};

/** What a delivery's error codes mean, for the ones a person can act on. */
const ERROR_LABELS: Record<string, string> = {
  timeout: "No answer within 10 seconds",
  connection: "Couldn't connect",
  redirect: "Answered with a redirect, which is never followed",
  subscription_gone: "The subscription was removed or turned off",
  event_gone: "The event is past its 30 days",
  email_not_configured:
    "This Gateway can't send mail yet: set EMAIL_FROM, then redeliver",
  email_budget_exhausted: "Today's email budget is spent; it is retried",
  email_send_failed: "The mail provider refused the message",
  no_recipients: "No owner or admin to mail",
};

/**
 * A delivery's last error as a line a person reads and the receiver's own
 * words, when it answered: `status_500: upstream down` is "HTTP 500" and
 * "upstream down".
 */
export function describeDeliveryError(error: string): {
  label: string;
  detail: string | null;
} {
  const separator = error.indexOf(": ");
  const code = separator === -1 ? error : error.slice(0, separator);
  const detail = separator === -1 ? null : error.slice(separator + 2);
  const status = /^status_(\d{3})$/.exec(code);
  if (status) return { label: `HTTP ${status[1]}`, detail };
  if (code === "target_refused") {
    return {
      label: "The Gateway refuses this URL now",
      detail: detail ? detail.replace(/_/g, " ") : null,
    };
  }
  if (code === "partial") return { label: "Some mail wasn't sent", detail };
  return { label: ERROR_LABELS[code] ?? code.replace(/_/g, " "), detail };
}

/** The envelope's organization, as each delivery carries it. */
type EnvelopeOrganization = { id: string; slug: string; name: string };

/**
 * The body a receiver got for this event (section 2): the stored event,
 * with the Gateway's address and the organization every delivery adds.
 * Both are read now, as a redelivery would send them.
 */
export function eventEnvelope(
  event: EventDeliveryEvent,
  context: { gateway: string; organization: EnvelopeOrganization | null },
): { [key: string]: JsonValue } {
  return {
    id: event.id,
    type: event.type,
    version: event.version,
    summary: event.summary,
    time: event.time,
    gateway: context.gateway,
    ...(context.organization
      ? {
          organization: {
            id: context.organization.id,
            slug: context.organization.slug,
            name: context.organization.name,
          },
        }
      : {}),
    actor: event.actor,
    data: event.data,
  };
}

/** The Add dialog's group headings; a ping is sent from Send test, never subscribed to. */
const GROUP_LABELS: Partial<Record<EventGroup, string>> = {
  member: "Members",
  organization: "Workspace",
  app: "Apps",
  cap: "Monthly caps",
  group: "Groups",
  tool: "Agent tool calls",
  connection: "AI connections",
  token: "Tokens",
  access: "Cloudflare Access",
  mcp_app: "MCP apps",
  provider: "API providers",
  subscription: "Event subscriptions",
};

export type EventTypeGroup = {
  group: EventGroup;
  label: string;
  /** `member.*`: every type in the group (and for `app.*`, every app's own events too). */
  pattern: string;
  types: EventTypeInfo[];
};

/** The catalogue in the order it came, grouped by prefix, without `ping`. */
export function groupEventTypes(
  types: readonly EventTypeInfo[],
): EventTypeGroup[] {
  const groups = new Map<EventGroup, EventTypeGroup>();
  for (const info of types) {
    const label = GROUP_LABELS[info.group];
    if (!label) continue;
    const existing = groups.get(info.group);
    if (existing) existing.types.push(info);
    else {
      groups.set(info.group, {
        group: info.group,
        label,
        pattern: `${info.group}.*`,
        types: [info],
      });
    }
  }
  return [...groups.values()];
}

/** A comma- or space-separated list of patterns someone typed, trimmed and deduplicated. */
export function parsePatterns(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    ),
  ];
}

/** What is wrong with the first typed pattern that is wrong, or null (the server's own rule). */
export function patternsProblem(patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    const problem = eventPatternProblem(pattern);
    if (problem) return problem;
  }
  return null;
}

/**
 * A subscription's patterns split for the Add dialog: whether it takes
 * everything, the catalogue's types and group patterns it names (the
 * checkboxes), and the rest (an app's own events, typed by hand).
 */
export function splitPatterns(
  patterns: readonly string[],
  groups: readonly EventTypeGroup[],
): { everything: boolean; selected: string[]; custom: string[] } {
  if (isEverything(patterns)) {
    return { everything: true, selected: [], custom: [] };
  }
  const known = new Set<string>();
  for (const group of groups) {
    known.add(group.pattern);
    for (const info of group.types) known.add(info.type);
  }
  return {
    everything: false,
    selected: patterns.filter((pattern) => known.has(pattern)),
    custom: patterns.filter((pattern) => !known.has(pattern)),
  };
}
