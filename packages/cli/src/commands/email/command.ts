import { buildCommand, buildRouteMap } from "@stricli/core";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

/** The lists `email unset` clears. */
export enum EmailList {
  Senders = "senders",
  Inbound = "inbound",
}

const appFlags = {
  manifest: {
    kind: "parsed",
    parse: String,
    brief: "Path to everyapp.config.ts, if it isn't in this directory",
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
        brief: "Address the app may send as: '*@<domain>' or one address (repeat, up to 20)",
      },
      inbound: {
        kind: "parsed",
        parse: String,
        variadic: true,
        optional: true,
        placeholder: "address",
        brief: "Address whose mail goes to the app: '*@<apex>' or one address (repeat, up to 50)",
      },
      "enable-email-routing": {
        kind: "boolean",
        optional: true,
        brief: "Turn on Email Routing for inbound domains without asking",
      },
      ...appFlags,
    },
  },
  docs: {
    brief: "Set senders or inbound addresses, without a deploy",
    fullDescription: [
      "Each flag replaces its whole list; a list you don't name is kept. The Gateway",
      "picks up a change within 30 seconds, without a deploy. Addresses set before",
      "the app's first upload are routed by its next deploy.",
      "",
      "Requirements:",
      "  --sender   everyapp.config.ts lists capabilities.email; each domain is set up for Email Sending",
      "  --inbound  everyapp.config.ts declares email: { inbound: true }; the domain is on Cloudflare DNS",
      "",
      "Examples:",
      "  everyapp email set --sender '*@mail.example.com'",
      "  everyapp email set --inbound reports@mail.example.com",
      "  everyapp email set --inbound '*@example.com' --enable-email-routing",
    ].join("\n"),
  },
});

const unsetCommand = buildCommand({
  loader: async () => {
    const { unset } = await import(".");
    return unset;
  },
  parameters: {
    positional: {
      kind: "array",
      minimum: 1,
      parameter: {
        brief: "List to clear: senders or inbound",
        placeholder: "senders|inbound",
        parse: (value: string): EmailList => {
          const list = Object.values(EmailList).find((name) => name === value);
          if (!list) throw new Error("Use senders, inbound, or both.");
          return list;
        },
      },
    },
    flags: appFlags,
  },
  docs: {
    brief: "Clear senders or inbound addresses, without a deploy",
    fullDescription: [
      "Clearing inbound addresses removes their Email Routing rules; a catch-all goes",
      "back to dropping mail. Nothing is built or deployed.",
      "",
      "Examples:",
      "  everyapp email unset inbound",
      "  everyapp email unset senders inbound",
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
    brief: "Show the app's senders and inbound addresses",
    fullDescription: [
      "Lists the app's senders and inbound addresses on the Gateway, and whether each",
      "inbound address is routed.",
      "",
      "Examples:",
      "  everyapp email show",
      "  everyapp email show --manifest ../analytics/everyapp.config.ts",
    ].join("\n"),
  },
});

export const emailRoutes = buildRouteMap({
  routes: { show: showCommand, set: setCommand, unset: unsetCommand },
  docs: {
    brief: "Manage the addresses an app sends as and receives at",
  },
});
