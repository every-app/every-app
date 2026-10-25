/**
 * The `everyapp events` route map: each command's arguments, flags and help
 * (the handlers are in ./index.ts and the files beside it). Every command
 * that reaches the Gateway takes --org, --gateway, --account-id, --json and
 * --verbose; `types` reads the CLI's own catalogue and takes only the last
 * two.
 */
import { buildCommand, buildRouteMap } from "@stricli/core";
import { EVENT_EMAIL_RECIPIENTS, EVENTS_ALLOW_PRIVATE_TARGETS_SETTING } from "@every-app/sdk/internal";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, orgFlag, verboseFlag } from "../flags";
import { parseLimit } from "./deliveries";

/** Every events command that reaches the Gateway: which organization, where the Gateway is, and how to print. */
const eventsFlags = {
  org: orgFlag,
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const subscriptionParameter = {
  placeholder: "id",
  brief: "The subscription, by its sub_ id (events list names them)",
  parse: String,
} as const;

const addCommand = buildCommand({
  loader: async () => {
    const { add } = await import(".");
    return add;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "url",
          brief: "The webhook's https:// URL (leave it out with --email)",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      events: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "types",
        brief:
          "The events to send, comma separated: types (member.joined), prefixes (cap.*, app.crm.*) or * (repeat to add more; default: every event but test pings)",
      },
      name: {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "text",
        brief: "What to call it, like 'Slack #ops' (default: the URL's host, or Email owners and admins)",
      },
      email: {
        kind: "enum",
        values: EVENT_EMAIL_RECIPIENTS,
        optional: true,
        brief: "Mail each event to the organization's owners, or its owners and admins (admins), instead of a webhook",
      },
      secret: {
        kind: "boolean",
        optional: true,
        brief:
          "Give the webhook's signing secret yourself, 16 to 128 characters: asked at a hidden prompt, or read piped in, never typed on the command line (default: one is made and shown once)",
      },
      "secret-from-env": {
        kind: "parsed",
        parse: String,
        optional: true,
        placeholder: "VAR",
        brief: "Read the signing secret from this environment variable",
      },
      ...eventsFlags,
    },
  },
  docs: {
    brief: "Send the organization's events to a URL (a signed POST) or by email to its owners and admins",
    fullDescription: [
      "A webhook gets each event as a JSON POST, signed with the subscription's secret:",
      "X-EveryApp-Signature: t=<seconds>,v1=<hex>, HMAC-SHA256 over <t>.<body>; the receiver checks",
      "it (/docs/events has the code). Without --secret one is made and shown once: copy it then.",
      "Slack's Workflow Builder, Zapier, n8n, Make and your own endpoint all take one; the body's",
      "top-level summary is a line a person reads.",
      "",
      "The URL must be https:// on a public hostname: not an IP address, not a local or internal",
      "name, not the Gateway or one of its apps. For a receiver on a private network, set",
      `${EVENTS_ALLOW_PRIVATE_TARGETS_SETTING} on the Gateway with the value "true" (self-host only;`,
      `${CLI} secret set ${EVENTS_ALLOW_PRIVATE_TARGETS_SETTING}): then http://, IP addresses and private names are let through.`,
      "",
      "--email mails each event to the organization's owners (owners) or owners and admins",
      "(admins), from the Gateway's sender (EMAIL_FROM); it takes no address. An organization has at",
      "most 25 subscriptions. The Gateway sends each event within a minute.",
      "",
      "Examples:",
      `  ${CLI} events add https://hooks.example.com/everyapp --events cap.*,member.*`,
      `  ${CLI} events add https://hooks.zapier.com/hooks/catch/1/abc --name Zapier --secret`,
      `  ${CLI} events add --email admins --events cap.*`,
      `  ${CLI} events add https://n8n.example.com/webhook/x --secret-from-env N8N_SECRET --json`,
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: eventsFlags },
  docs: {
    brief: "List the organization's subscriptions: where each goes, what it takes, how its last delivery went",
    fullDescription: [
      "A webhook shows its URL's host and path (never its query or secret); an email one, whom it",
      "mails. Nothing is changed.",
      "",
      "Example:",
      `  ${CLI} events list`,
    ].join("\n"),
  },
});

const removeCommand = buildCommand({
  loader: async () => {
    const { remove } = await import(".");
    return remove;
  },
  parameters: { positional: { kind: "tuple", parameters: [subscriptionParameter] }, flags: eventsFlags },
  docs: {
    brief: "Remove a subscription (a built-in one is disabled instead)",
    fullDescription: [
      "Nothing more is delivered to it; its delivery log stays for 30 days. The Gateway's built-in",
      "cap alerts are disabled instead of removed, so the Gateway never makes them again.",
      "",
      "Example:",
      `  ${CLI} events remove sub_0123456789abcdef01234567`,
    ].join("\n"),
  },
});

const enableCommand = buildCommand({
  loader: async () => {
    const { enable } = await import(".");
    return enable;
  },
  parameters: { positional: { kind: "tuple", parameters: [subscriptionParameter] }, flags: eventsFlags },
  docs: {
    brief: "Resume a subscription: new events are queued for it again",
    fullDescription: [
      "What happened while it was disabled isn't sent. Safe to repeat.",
      "",
      "Example:",
      `  ${CLI} events enable sub_0123456789abcdef01234567`,
    ].join("\n"),
  },
});

const disableCommand = buildCommand({
  loader: async () => {
    const { disable } = await import(".");
    return disable;
  },
  parameters: { positional: { kind: "tuple", parameters: [subscriptionParameter] }, flags: eventsFlags },
  docs: {
    brief: "Pause a subscription: no new events are queued for it, and what is queued is dropped",
    fullDescription: [
      "Turn the built-in cap alerts off this way. Safe to repeat; events enable resumes it.",
      "",
      "Example:",
      `  ${CLI} events disable sub_0123456789abcdef01234567`,
    ].join("\n"),
  },
});

const testCommand = buildCommand({
  loader: async () => {
    const { test } = await import(".");
    return test;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [subscriptionParameter] },
    flags: {
      "no-wait": {
        kind: "boolean",
        optional: true,
        brief: "Return once the test event is queued; events deliveries shows how it went",
      },
      ...eventsFlags,
    },
  },
  docs: {
    brief: "Send a test event (ping) to one subscription and wait to see whether it was delivered",
    fullDescription: [
      "Queues a ping for that subscription only, then waits up to 90 seconds while the Gateway",
      "sends it (it sends queued events every minute), and says delivered or failed with the",
      "receiver's status code or the error. A failed test is retried like any delivery.",
      "",
      "Examples:",
      `  ${CLI} events test sub_0123456789abcdef01234567`,
      `  ${CLI} events test sub_0123456789abcdef01234567 --no-wait --json`,
    ].join("\n"),
  },
});

const deliveriesCommand = buildCommand({
  loader: async () => {
    const { deliveries } = await import(".");
    return deliveries;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ ...subscriptionParameter, brief: "Only this subscription's (default: every subscription's)", optional: true }],
    },
    flags: {
      dead: {
        kind: "boolean",
        optional: true,
        brief: "Only deliveries that ran out of attempts (dead), to redeliver",
      },
      limit: {
        kind: "parsed",
        parse: parseLimit,
        optional: true,
        placeholder: "n",
        brief: "How many to show, newest first: 1 to 200 (default 20)",
      },
      ...eventsFlags,
    },
  },
  docs: {
    brief: "List the last deliveries (30 days): the event, its subscription, attempts, status, next attempt, last error",
    fullDescription: [
      "A delivery is retried after 1, 5 and 30 minutes, then 2, 8 and 24 hours; the seventh failure",
      "is dead. Nothing is changed.",
      "",
      "Examples:",
      `  ${CLI} events deliveries`,
      `  ${CLI} events deliveries sub_0123456789abcdef01234567 --limit 50`,
      `  ${CLI} events deliveries --dead`,
    ].join("\n"),
  },
});

const redeliverCommand = buildCommand({
  loader: async () => {
    const { redeliverDelivery } = await import(".");
    return redeliverDelivery;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [{ placeholder: "delivery", brief: "The delivery, by its dlv_ id (events deliveries names them)", parse: String }],
    },
    flags: eventsFlags,
  },
  docs: {
    brief: "Send a failing or dead delivery again: the Gateway sends it within a minute, with the full retry schedule",
    fullDescription: [
      "Its attempts start over at 0. A delivered one is left alone. The receiver may get the same",
      "event id again: receivers deduplicate on it.",
      "",
      "Example:",
      `  ${CLI} events redeliver dlv_0123456789abcdef01234567`,
    ].join("\n"),
  },
});

const typesCommand = buildCommand({
  loader: async () => {
    const { types } = await import(".");
    return types;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: { json: jsonFlag, verbose: verboseFlag } },
  docs: {
    brief: "List the event types --events takes, with their versions",
    fullDescription: [
      "The catalogue this CLI knows, and how a pattern names several (member.*, app.crm.*, *). No",
      "Gateway is needed.",
      "",
      "Example:",
      `  ${CLI} events types`,
    ].join("\n"),
  },
});

/**
 * `everyapp events …`: subscriptions to the Gateway's events, the
 * deliveries, and the catalogue (docs/design/2026-10-events-out.md, section 8).
 */
export const eventsRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    list: listCommand,
    remove: removeCommand,
    enable: enableCommand,
    disable: disableCommand,
    test: testCommand,
    deliveries: deliveriesCommand,
    redeliver: redeliverCommand,
    types: typesCommand,
  },
  aliases: { ls: "list" },
  docs: {
    brief: "Send the Gateway's events to Slack, Zapier, n8n or your own endpoint (signed), or by email",
  },
});
