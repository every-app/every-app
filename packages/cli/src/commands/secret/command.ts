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

/** `set` and `unset`: which app a name that isn't a Gateway setting belongs to. */
const appFlag = {
  kind: "parsed",
  parse: String,
  brief: "The app whose secret this is (default: the app in this directory)",
  placeholder: "id",
  optional: true,
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
      app: appFlag,
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
      "directory. Other names go to the app in this directory, or with --app <id> to that app from",
      "anywhere; the app's everyapp.config.ts must list them under secrets. Values come from a",
      "hidden prompt, --from-env or stdin, never the command line. Changes are live at once; no",
      "deploy needed.",
      "",
      "Examples:",
      `  ${CLI} secret set OPENAI_API_KEY`,
      `  ${CLI} secret set GITHUB_TOKEN --from-env GITHUB_TOKEN`,
      `  echo "$STRIPE_KEY" | ${CLI} secret set STRIPE_KEY`,
      `  ${CLI} secret set MAIN_SECRET --app analytics`,
      "",
      `See what an app needs and what is set: ${CLI} secret list [<app>]`,
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
      app: appFlag,
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
      "Names go where `secret set` sends them (--app <id> names the app from anywhere). Asks before",
      "removing; the change is live at once.",
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
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "An app id (default: the app in this directory; elsewhere, every app)",
          parse: String,
          placeholder: "app",
          optional: true,
        },
      ],
    },
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
    brief: "List what an app needs set and what is: its own secrets and the Gateway's settings",
    fullDescription: [
      "For one app (the app in this directory, or <app> from anywhere): every setting its manifest",
      "declares, where it is held (the Gateway, or the app's Worker), whether it is set, and the one",
      `command that opens the app when something required is missing (${CLI} configure <app>).`,
      "Elsewhere with no app named: the Gateway's names and who set them, then every app's",
      "settings. Names only, never values.",
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
