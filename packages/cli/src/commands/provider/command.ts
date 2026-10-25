import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const idParameter = {
  placeholder: "id",
  brief: "The provider's id (provider list names them): stripe",
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
          placeholder: "spec",
          brief: "The provider's spec: a JSON file, or an https URL to one (64 KiB at most)",
          parse: String,
        },
      ],
    },
    flags: {
      replace: {
        kind: "boolean",
        brief: "Replace the provider registered under the spec's id; its key must be set again",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Register an API provider on the Gateway from its spec, so apps can list it under capabilities",
    fullDescription: [
      "The spec says what the provider is and where its key goes: its id, name, the page the key",
      "comes from (docs), the only hosts the key is ever sent to, and how it is sent (auth: bearer,",
      "header, query or basic), naming the Gateway setting that holds the key (STRIPE_API_KEY for",
      "stripe). It never holds the key itself. A URL is fetched on this machine.",
      "",
      "The rules a spec must pass: an id that isn't a built-in provider's, settings named after the",
      "id that no other provider, app or the Gateway itself reads, and public hosts that aren't the",
      "Gateway's own or its apps'. The Gateway checks them again every time it reads the row.",
      "",
      "Next, set the key; the Gateway sends it only to the hosts the row had when it was set:",
      `  ${CLI} secret set STRIPE_API_KEY`,
      "",
      "Run in an app's directory, it also writes .everyapp/providers/<id>.json, which everyapp dev",
      "reaches the provider from with your key in .dev.vars.",
      "",
      "Examples:",
      `  ${CLI} provider add stripe.json`,
      `  ${CLI} provider add https://example.com/providers/stripe.json`,
      `  ${CLI} provider add stripe.json --replace`,
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: { positional: { kind: "tuple", parameters: [] }, flags: connectFlags },
  docs: {
    brief: "List the API providers the Gateway offers: built in and registered, each key's state, the apps using each",
    fullDescription: [
      "Nothing is changed. A key's value can't be read back; only whether it is set, and for a",
      "registered provider whether it was set for the hosts the row names now (bound).",
      "",
      "Example:",
      `  ${CLI} provider list`,
    ].join("\n"),
  },
});

const showCommand = buildCommand({
  loader: async () => {
    const { show } = await import(".");
    return show;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: {
      save: {
        kind: "boolean",
        brief: "Also write the spec to .everyapp/providers/<id>.json in this app's directory, for everyapp dev",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Print a provider's spec: its hosts, how its key is sent, its settings, who registered it and which apps use it",
    fullDescription: [
      "What an agent reads to set up and call a provider without a setup guide. With --save, in an",
      "app's directory, the spec is written where everyapp dev reads it.",
      "",
      "Examples:",
      `  ${CLI} provider show stripe`,
      `  ${CLI} provider show stripe --save`,
    ].join("\n"),
  },
});

const removeCommand = buildCommand({
  loader: async () => {
    const { remove } = await import(".");
    return remove;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: {
      force: {
        kind: "boolean",
        brief: "Remove it even though deployed apps list it (their calls to it stop)",
        optional: true,
      },
      ...connectFlags,
    },
  },
  docs: {
    brief: "Remove a registered provider from the Gateway; its key stays set until secret unset",
    fullDescription: [
      "The Gateway stops serving it within 30 seconds. A provider a deployed app lists under",
      "capabilities is refused unless --force. The Gateway setting holding its key stays; remove",
      `it with ${CLI} secret unset <NAME>. Registering it again needs the key set again too.`,
      "",
      "Example:",
      `  ${CLI} provider remove stripe`,
    ].join("\n"),
  },
});

/** `provider on|off`: what `everyapp mcp on|off` was called until 2026-10-24, kept through launch week. */
const mcpAlias = (verb: "on" | "off") =>
  buildCommand({
    loader: async () => {
      const handlers = await import(".");
      return verb === "on" ? handlers.on : handlers.off;
    },
    parameters: {
      positional: {
        kind: "tuple",
        parameters: [{ ...idParameter, brief: "The MCP app (mcp list names them): dataforseo" }],
      },
      flags: connectFlags,
    },
    docs: {
      brief: `Same as ${CLI} mcp ${verb}; this alias goes after launch week`,
    },
  });

/**
 * `everyapp provider add|list|show|remove`: the provider registry, the API
 * providers the Gateway brokers (docs/design/2026-10-provider-registry.md).
 * `on` and `off` are hidden: they run `mcp on|off` and say so, for
 * documents that still say `provider on`.
 */
export const providerRoutes = buildRouteMap({
  routes: {
    add: addCommand,
    list: listCommand,
    show: showCommand,
    remove: removeCommand,
    on: mcpAlias("on"),
    off: mcpAlias("off"),
  },
  aliases: { ls: "list", rm: "remove" },
  docs: {
    brief: "Register API providers for apps to call with the Gateway's key, beside the built-in ones",
    hideRoute: { on: true, off: true },
  },
});
