import { buildCommand } from "@stricli/core";
import { jsonFlag } from "../flags";

export const createCommand = buildCommand({
  loader: async () => import("."),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Lowercase letters, digits and dashes, e.g. my-app (asked for when missing)",
          parse: String,
          placeholder: "name",
          optional: true,
        },
      ],
    },
    flags: {
      deploy: {
        kind: "boolean",
        brief: "Deploy the app once it's created",
        optional: true,
      },
      gateway: {
        kind: "parsed",
        parse: String,
        brief: "With --deploy: your Gateway's URL (default: $EVERYAPP_GATEWAY_URL)",
        placeholder: "url",
        optional: true,
      },
      "account-id": {
        kind: "parsed",
        parse: String,
        brief: "With --deploy: the Cloudflare account, when your login sees several",
        placeholder: "id",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Don't ask anything (a name is then required)",
        optional: true,
      },
      json: jsonFlag,
      verbose: {
        kind: "boolean",
        brief: "Stream install and git output to stderr",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Create a new app from the starter template",
    fullDescription: [
      "Inside your Every App checkout the app goes in apps/<name>; anywhere else in ./<name>,",
      "with its own git repository. Dependencies are installed and the local database is ready,",
      "so `pnpm dev` works straight away.",
      "",
      "Examples:",
      "  pnpm everyapp create analytics",
      "  pnpm everyapp create analytics --deploy",
    ].join("\n"),
  },
});
