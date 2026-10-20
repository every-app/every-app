import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  accountFlag,
  gatewayFlag,
  jsonFlag,
  verboseFlag,
  yesFlag,
} from "../flags";

const nameArgument = {
  brief:
    "A Gateway setting (OPENAI_API_KEY, EMAIL_FROM, LINKEDIN_CLIENT_ID, …), or a secret the app in this directory lists under `secrets` in everyapp.config.ts (GITHUB_TOKEN, say)",
  parse: String,
  placeholder: "name",
};

const changeFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  yes: yesFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const setCommand = buildCommand({
  loader: async () => {
    const { set } = await import(".");
    return set;
  },
  parameters: {
    positional: { kind: "array", parameter: nameArgument },
    flags: {
      ...changeFlags,
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "Read the value from this environment variable instead of a hidden prompt",
        placeholder: "VAR",
        optional: true,
      },
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Set one or more secrets on the live Worker they belong to, without a deploy",
    fullDescription: [
      "Each name goes where it belongs: a Gateway setting (an AI provider's key, a capability's",
      "client, EMAIL_FROM, the MCP and Cloudflare Access switches, …) to the Gateway, from any",
      "directory; any other name to the app whose everyapp.config.ts is in this directory, which",
      "must list it under `secrets`. A name that is neither is refused before a value is read.",
      "",
      "Each value comes from a hidden prompt, or one from --from-env <VAR>, never the command line.",
      "The Worker (the app's and its helpers, or the Gateway) gets one new version with the change,",
      "live at once; nothing is built or deployed, and the next `everyapp deploy` or `setup` keeps",
      "the secrets. Names everyapp sets itself are refused: GATEWAY_URL and the EVERYAPP_*,",
      "EVERY_APP_* and APP__* names.",
    ].join("\n"),
  },
});

const unsetCommand = buildCommand({
  loader: async () => {
    const { unset } = await import(".");
    return unset;
  },
  parameters: {
    positional: { kind: "array", parameter: nameArgument },
    flags: changeFlags,
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Remove one or more secrets from the live Worker they belong to, without a deploy",
    fullDescription: [
      "Removes each name from where it belongs, as `secret set` routes them: a Gateway setting from",
      "the Gateway, any other name from the app in this directory (its Worker and helpers), whether",
      "or not everyapp.config.ts still lists it. One new version each, live at once; nothing is built",
      "or deployed.",
    ].join("\n"),
  },
});

const listCommand = buildCommand({
  loader: async () => {
    const { list } = await import(".");
    return list;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "List the secrets' names (never their values)",
    fullDescription: [
      "In an app's directory: the names on its deployed Worker (cf workers secrets list, everyapp's",
      "own included), the ones everyapp.config.ts lists under `secrets` that nobody set yet, and the",
      "Gateway settings its providers and capabilities need, set or not. Elsewhere: the Gateway's.",
    ].join("\n"),
  },
});

export const secretRoutes = buildRouteMap({
  routes: {
    set: setCommand,
    unset: unsetCommand,
    list: listCommand,
  },
  docs: {
    brief: "Set, remove and list secrets and Gateway settings",
  },
});
