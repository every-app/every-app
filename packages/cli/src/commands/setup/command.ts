import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { forceDnsFlag, jsonFlag, yesFlag } from "../flags";

export const setupCommand = buildCommand({
  loader: async () => {
    const { setup } = await import(".");
    return setup;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      domain: {
        kind: "parsed",
        parse: String,
        brief:
          "Where the Gateway lives: any hostname under one of the account's domains, e.g. apps.example.com (asked at a terminal; remembered after that)",
        optional: true,
      },
      "account-id": {
        kind: "parsed",
        parse: String,
        brief:
          "The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)",
        optional: true,
      },
      "force-dns": forceDnsFlag,
      "allow-downgrade": {
        kind: "boolean",
        brief:
          "Deploy this Gateway even though it is older than the live one (a deliberate rollback)",
        optional: true,
        hidden: true,
      },
      redeploy: {
        kind: "boolean",
        brief:
          "Upload the Gateway even when it is up to date (after a change in the dashboard, such as a key rotation)",
        optional: true,
        hidden: true,
      },
      yes: yesFlag,
      json: jsonFlag,
      verbose: {
        kind: "boolean",
        brief:
          "Show every step and progress line, and stream the Gateway's build output to stderr",
        optional: true,
      },
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Install or repair the Gateway",
    fullDescription: [
      "One command from an empty Cloudflare account (Workers Paid) to a working Gateway and its",
      "owner, and the one to run when something is off. Run it again any time: it picks up where it",
      `stopped, and does nothing once everything is there. After a git pull, ${CLI} update takes`,
      "the newer Gateway from this checkout (setup does that too, on its way).",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in",
      "     the login's accounts; with none, picks the account to install it in",
      "  2. Picks where the Gateway lives (--domain, or asked): any hostname under one of the",
      "     account's domains, apps.example.com; apps get one each below it, todo.apps.example.com",
      "  3. Installs the Gateway from this checkout (apps/every-app-gateway), or repairs it, and",
      "     waits for its certificate",
      "  4. Opens a one-time link to create the owner account and waits up to 15 minutes for it;",
      "     in CI there is no link, and the run ends with a warning to run setup at a terminal",
      "",
      "The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own",
      "questions; never cf's). With --json each step is an NDJSON event; a run that stops on",
      "something only a person can do exits 2 with action_required.",
      `Then: ${CLI} create my-app, cd into it, ${CLI} dev, ${CLI} deploy.`,
      "More: https://everyapp.com/docs/gateway",
    ].join("\n"),
  },
});
