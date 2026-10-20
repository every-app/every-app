import { buildCommand, buildRouteMap } from "@stricli/core";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const appFlags = {
  manifest: {
    kind: "parsed",
    parse: String,
    brief:
      "The app's everyapp.config.ts, when it isn't in this directory (an app registered with `register --manifest`, or deployed from a release)",
    placeholder: "path",
    optional: true,
  },
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const setCommand = buildCommand({
  loader: async () => {
    const { set } = await import(".");
    return set;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      sender: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "pattern",
        brief:
          'An address the app may send as: "*@<domain>" (any address on exactly that domain) or one address, in lowercase. Repeat for several; together they replace the app\'s senders',
      },
      inbound: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "address",
        brief:
          'An address Email Routing delivers to the app\'s email() handler: "*@<apex>" (the zone\'s catch-all) or one address, in lowercase. Repeat for several; together they replace the app\'s inbound addresses',
      },
      "enable-email-routing": {
        kind: "boolean",
        optional: true,
        brief:
          "Turn on Email Routing for the domains the inbound addresses name that don't route mail yet (locks their MX and SPF records to Cloudflare)",
      },
      ...appFlags,
    },
  },
  docs: {
    brief:
      "Set the addresses the app in this directory sends as and receives at, on the Gateway, without a deploy",
    fullDescription: [
      "The app's installation on the Gateway holds two lists the manifest doesn't. --sender replaces the",
      "From addresses the Gateway lets it name ('*@<domain>' for any address on exactly that domain, or",
      "one address; 20 at most); everyapp.config.ts must list capabilities.email, and each domain must",
      "also be onboarded to the Gateway's email provider (docs/runbooks/email-sending-setup.md).",
      "--inbound replaces the addresses Email Routing delivers to its email() handler ('*@<apex>' is",
      "the zone's catch-all, a subdomain takes one address each; 50 at most); everyapp.config.ts must",
      "declare email: { inbound: true }. Inbound addresses are routed at once with the deploy's checks",
      "(the zone, taken addresses, catch-alls on an apex only; turning routing on for a domain asks",
      "first, or --enable-email-routing) and the rules are recorded as the app's. A list not named",
      "is kept. The app must be deployed; addresses set before its Worker is uploaded are routed by",
      "its next `everyapp deploy`. The Gateway reads a change within 30 seconds.",
    ].join("\n"),
  },
});

const unsetCommand = buildCommand({
  loader: async () => {
    const { unset } = await import(".");
    return unset;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      senders: {
        kind: "boolean",
        optional: true,
        brief: "Clear the app's senders: it sends as the Gateway's sender only",
      },
      inbound: {
        kind: "boolean",
        optional: true,
        brief: "Clear the app's inbound addresses and remove their Email Routing rules",
      },
      ...appFlags,
    },
  },
  docs: {
    brief: "Clear the app's senders and/or inbound addresses on the Gateway, without a deploy",
    fullDescription: [
      "Names what to clear: --senders, --inbound, or both. Clearing the inbound addresses removes the",
      "Email Routing rules the app recorded (a catch-all goes back to dropping mail). Nothing is built",
      "or deployed.",
    ].join("\n"),
  },
});

const showCommand = buildCommand({
  loader: async () => {
    const { show } = await import(".");
    return show;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: appFlags },
  docs: {
    brief: "Show the addresses the app in this directory sends as and receives at",
    fullDescription: [
      "What the Gateway holds for the app: the senders it accepts from it and the addresses routed to",
      "its Worker, against what everyapp.config.ts declares, and whether every address has its Email",
      "Routing rule. With --json, the `done` event's data has it.",
    ].join("\n"),
  },
});

export const emailRoutes = buildRouteMap({
  routes: { set: setCommand, unset: unsetCommand, show: showCommand },
  defaultCommand: "show",
  docs: {
    brief:
      "The addresses the app sends as and receives at: its installation's on the Gateway, not the manifest's",
  },
});
