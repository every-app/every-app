import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, resultJsonFlag } from "../flags";

const names = {
  kind: "array",
  minimum: 1,
  parameter: {
    brief: "Secret or Gateway setting",
    parse: String,
    placeholder: "name",
  },
} as const;

const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
} as const;

const setCommand = buildCommand({
  loader: async () => {
    const { set } = await import(".");
    return set;
  },
  parameters: {
    positional: names,
    flags: {
      "from-env": {
        kind: "parsed",
        parse: String,
        brief: "Read the value from this environment variable",
        placeholder: "VAR",
        optional: true,
      },
      ...connectFlags,
      json: jsonFlag,
      verbose: {
        kind: "boolean",
        brief: "Show which Worker each secret goes to and its new version",
        optional: true,
      },
    },
  },
  docs: {
    brief: "Set secrets on your app or your Gateway",
    fullDescription: [
      "Gateway settings (AI provider keys, EMAIL_FROM, sign-in clients) go to the Gateway, from any",
      "directory. Other names go to the app in this directory, which must list them under secrets",
      "in everyapp.config.ts. Values come from a hidden prompt, --from-env or stdin, never the",
      "command line. Changes are live at once; no deploy needed.",
      "",
      "Examples:",
      `  ${CLI} secret set OPENAI_API_KEY`,
      `  ${CLI} secret set GITHUB_TOKEN --from-env GITHUB_TOKEN`,
      `  echo "$STRIPE_KEY" | ${CLI} secret set STRIPE_KEY`,
      "",
      `See which names you can set: ${CLI} secret list`,
    ].join("\n"),
  },
});

const unsetCommand = buildCommand({
  loader: async () => {
    const { unset } = await import(".");
    return unset;
  },
  parameters: {
    positional: names,
    flags: {
      yes: { kind: "boolean", brief: "Remove without asking", optional: true },
      ...connectFlags,
      json: {
        kind: "boolean",
        brief: "Print NDJSON events on stdout (never asks)",
        optional: true,
      },
      verbose: {
        kind: "boolean",
        brief: "Show which Worker each secret is removed from",
        optional: true,
      },
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Remove secrets from your app or your Gateway",
    fullDescription: [
      "Names go where `secret set` sends them. Asks before removing; the change is live at once.",
      "",
      "Example:",
      `  ${CLI} secret unset GITHUB_TOKEN`,
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
      ...connectFlags,
      json: resultJsonFlag,
      verbose: {
        kind: "boolean",
        brief: "Also list the names everyapp sets itself",
        optional: true,
      },
    },
  },
  docs: {
    brief: "List secrets: the app's in its directory, the Gateway's anywhere else",
    fullDescription:
      "In an app's directory: its secrets and the Gateway settings it uses, with what's missing.\nElsewhere: the Gateway's, and the settings you can set on it.",
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
