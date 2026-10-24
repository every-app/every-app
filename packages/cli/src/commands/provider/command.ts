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
  brief: "The provider app (provider list names them): dataforseo",
  parse: String,
} as const;

const onCommand = buildCommand({
  loader: async () => {
    const { on } = await import(".");
    return on;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Turn a provider app on: its tools reach members' AI clients through the Gateway's /mcp",
    fullDescription: [
      "A provider app is a data provider (DataForSEO) offered as an app of the Gateway's own,",
      "with nothing to deploy: the Gateway serves the provider's tools on its /mcp under",
      "<id>_<tool> names, with its own key, and counts and audits every call like an app's.",
      "It appears in Admin → Apps and the app library like any app; you, the owners and the",
      "admins get it at once, and an admin grants other members with Manage access.",
      "",
      "The provider's key is a Gateway setting the tools need (provider list names it):",
      `  ${CLI} secret set DATAFORSEO_API_KEY`,
      "",
      "Safe to repeat: an app that is on stays on, with its access.",
      "",
      "Examples:",
      `  ${CLI} provider on dataforseo`,
      `  ${CLI} provider on dataforseo --json`,
    ].join("\n"),
  },
});

const offCommand = buildCommand({
  loader: async () => {
    const { off } = await import(".");
    return off;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [idParameter] },
    flags: connectFlags,
  },
  docs: {
    brief: "Turn a provider app off: it leaves /mcp and the app library, and everyone's access to it goes",
    fullDescription: [
      "Like deleting an app: the Gateway stops serving the provider's tools within 30 seconds, and",
      "everyone's access to it, the personal tokens bound to it and its place in AI connections go",
      "with it. The Gateway setting holding the provider's key stays; unset it with",
      `${CLI} secret unset <NAME> if nothing else needs it. Turning it on again starts fresh.`,
      "",
      "Example:",
      `  ${CLI} provider off dataforseo`,
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
    brief: "List the provider apps the Gateway offers: which are on, and whether each one's key is set",
    fullDescription: [
      "Nothing is changed. The key's value can't be read back; only whether it is set.",
      "",
      "Example:",
      `  ${CLI} provider list`,
    ].join("\n"),
  },
});

export const providerRoutes = buildRouteMap({
  routes: { on: onCommand, off: offCommand, list: listCommand },
  aliases: { ls: "list" },
  docs: {
    brief: "Offer a data provider (DataForSEO) to members' AI clients as an app, with the Gateway's key",
  },
});
