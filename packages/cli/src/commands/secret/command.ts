import { buildCommand, buildRouteMap } from "@stricli/core";
import {
  accountFlag,
  gatewayFlag,
  jsonFlag,
  verboseFlag,
  yesFlag,
} from "../flags";

const forFlag = {
  kind: "enum",
  values: ["gateway"],
  brief:
    "The Gateway's settings instead of the app's secrets (OPENAI_API_KEY, EMAIL_FROM, MCP_OAUTH_ENABLED, CLOUDFLARE_ACCESS_AUD, …)",
  optional: true,
} as const;

const nameArgument = {
  brief: "The secret's name, e.g. GITHUB_TOKEN (with --for gateway, the setting's)",
  parse: String,
  placeholder: "name",
};

const changeFlags = {
  for: forFlag,
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
    brief: "Set one or more secrets on the live Worker, without a deploy",
    fullDescription: [
      "Sets secrets the app's Worker reads from env (an API key it calls out with, say), each from a",
      "hidden prompt, or one from --from-env <VAR>, never the command line. The app's Worker and its",
      "helpers each get one new version with the change, live at once; nothing is built or deployed,",
      "and the next `everyapp deploy` keeps the secrets. Names everyapp sets itself are refused:",
      "GATEWAY_URL and the EVERYAPP_*, EVERY_APP_* and APP__* names.",
      "",
      "With --for gateway, sets the Gateway's optional settings instead (any other name lists them)",
      "on the live Gateway, which reads them on its next request.",
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
    brief: "Remove one or more secrets from the live Worker, without a deploy",
    fullDescription: [
      "Removes the secrets from the app's Worker and its helpers in one new version each, live at",
      "once, as `secret set` does; nothing is built or deployed. With --for gateway, removes the",
      "Gateway's optional settings instead.",
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
      for: forFlag,
      gateway: gatewayFlag,
      "account-id": accountFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "List the secrets' names (never their values)",
    fullDescription:
      "Lists the names of the secrets on the app's deployed Worker (cf workers secrets list), everyapp's own included; with --for gateway, the Gateway's.",
  },
});

export const secretRoutes = buildRouteMap({
  routes: {
    set: setCommand,
    unset: unsetCommand,
    list: listCommand,
  },
  docs: {
    brief: "The app's secrets, or the Gateway's settings with --for gateway",
  },
});
