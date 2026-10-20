import { buildCommand } from "@stricli/core";
import { jsonFlag } from "../flags";

export const createCommand = buildCommand({
  loader: async () => import("."),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "App id (kebab-case, e.g. my-app; asked for at a terminal when missing)",
          parse: String,
          placeholder: "id",
          optional: true,
        },
      ],
    },
    flags: {
      deploy: {
        kind: "boolean",
        brief: "Deploy the new app once it is created (see `everyapp deploy`)",
        optional: true,
      },
      gateway: {
        kind: "parsed",
        parse: String,
        brief:
          "With --deploy: the Gateway's URL, checked against the Gateway in your Cloudflare account (default: EVERYAPP_GATEWAY_URL)",
        optional: true,
      },
      "account-id": {
        kind: "parsed",
        parse: String,
        brief:
          "With --deploy: the Cloudflare account of the Gateway, when your login sees several (default: CLOUDFLARE_ACCOUNT_ID)",
        optional: true,
      },
      json: jsonFlag,
      verbose: {
        kind: "boolean",
        brief: "Show every step, and stream install output to stderr",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Never ask anything (an app id is then required)",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Create an app from the starter template",
    fullDescription: [
      "Copies the simple-todo starter template into apps/<id> inside this checkout, or ./<id> anywhere",
      "else, and readies it for `everyapp dev`. It doesn't contact your Gateway.",
      "",
      "  1. Names the app after <id> (asked for at a terminal when it's missing)",
      "  2. Puts the everyapp skill in .claude/skills/everyapp and .agents/skills/everyapp, for",
      "     coding agents (asks before adding a line to an AGENTS.md that doesn't mention it;",
      "     never under --json or --yes)",
      "  3. Installs its dependencies",
      "  4. Generates the Worker's types and applies its migrations to the local database",
      "  5. Outside the checkout, starts a git repository for it",
      "  6. With --deploy, deploys it as `everyapp deploy` does",
      "",
      "Then: cd into it and run `pnpm dev`; `everyapp deploy` when it should go live.",
    ].join("\n"),
  },
});
