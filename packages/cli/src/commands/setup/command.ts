import { buildCommand } from "@stricli/core";

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
          "Where the gateway lives: any hostname in a zone the account has, e.g. apps.example.com (asked at a terminal)",
        optional: true,
      },
      "account-id": {
        kind: "parsed",
        parse: String,
        brief:
          "The Cloudflare account of the Gateway, or with none yet, the one to install it in (default: CLOUDFLARE_ACCOUNT_ID, or the only one)",
        optional: true,
      },
      "allow-free-plan": {
        kind: "boolean",
        brief: "Don't check for Workers Paid (demos; Every App needs it to run)",
        optional: true,
      },
      "force-dns": {
        kind: "boolean",
        brief:
          "Publish the gateway's hostnames even where a DNS record answers them (one at a hostname is replaced)",
        optional: true,
      },
      "allow-downgrade": {
        kind: "boolean",
        brief:
          "Deploy this checkout's Gateway even though it is older than the live one (a deliberate rollback)",
        optional: true,
        hidden: true,
      },
      "no-open": {
        kind: "boolean",
        brief: "Print the owner setup link without opening a browser",
        optional: true,
      },
      printSetupLink: {
        kind: "boolean",
        brief:
          "Print the owner setup link even in CI or with piped output (the log keeps it)",
        optional: true,
      },
      json: {
        kind: "boolean",
        brief:
          "Print only NDJSON events on stdout (exit 2: an action is required; then run it again)",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief:
          "Skip everyapp's own confirmations (never cf's questions, or the one before replacing a Worker changed outside everyapp)",
        optional: true,
      },
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
    brief: "Set up Every App in your Cloudflare account, from nothing to a working gateway",
    fullDescription: [
      "One command from an empty Cloudflare account to a working gateway and its owner. Run it",
      "again any time: it picks up where it stopped, and does nothing once everything is there.",
      "The gateway is built from this checkout. Your Cloudflare login is the only credential:",
      "apps deploy with it, on this machine or any other, even before the gateway has an owner.",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and picks the account",
      "  2. Checks for Workers Paid, which Every App needs (a warning, not a question)",
      "  3. Picks where the gateway lives: any hostname in a zone the account has (apps.example.com);",
      "     apps get one each below it (todo.apps.example.com), with their own DNS and certificate",
      "  4. Deploys the gateway (everyapp gateway deploy), and waits for its certificate",
      "  5. Opens a one-time link to create the owner account, and waits up to 15 minutes for it",
      "     (in CI it only says to run setup on your machine, unless --printSetupLink); a run",
      "     resumed later shows a new link, and the earlier one stops working",
      "",
      "Then deploy apps from the repository: cd apps/todo-app && pnpm run deploy.",
      "No domain on Cloudflare yet? Buy one in the dashboard (Domains → Buy a domain), then run it again.",
      "Nothing asks for a go-ahead: the first lines say which account and where. The Gateway's",
      "build output goes to a log file, never to stdout.",
      "With --json, each step is an NDJSON event; what a person must do is `action_required`",
      "(with its link and code), and the run exits 2 when it stops on one.",
    ].join("\n"),
  },
});
