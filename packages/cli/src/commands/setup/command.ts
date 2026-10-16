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
          "Cloudflare account id (default: CLOUDFLARE_ACCOUNT_ID, the one used before, or the only one)",
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
        brief: "Print progress as NDJSON events on stdout (exit 2: an action is required)",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief: "Skip confirmation prompts",
        optional: true,
      },
      verbose: {
        kind: "boolean",
        brief: "Show detailed output",
        optional: true,
      },
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Set up Every App in your Cloudflare account, from nothing to a working gateway",
    fullDescription: [
      "One command from an empty Cloudflare account to a working gateway, its owner, and this CLI",
      "logged in. Run it again any time: it picks up where it stopped, and does nothing once",
      "everything is there. The gateway is built from this checkout.",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and picks the account",
      "  2. Checks for Workers Paid, which Every App needs (a warning, not a stop)",
      "  3. Picks where the gateway lives: any hostname in a zone the account has (apps.example.com);",
      "     apps get one each below it (todo.apps.example.com), with their own DNS and certificate",
      "  4. Deploys the gateway (everyapp gateway deploy), and waits for its certificate",
      "  5. Opens a one-time link to create the owner account, then logs this CLI in by itself",
      "     (in CI it only says to run claim-link on your machine, unless --printSetupLink)",
      "",
      "Then deploy apps from the repository: cd apps/todo-app && pnpm run deploy.",
      "No domain on Cloudflare yet? Buy one in the dashboard (Domains → Buy a domain), then run it again.",
      "With --json, each step is an NDJSON event; what a person must do is `action_required`",
      "(with its link and code), and the run exits 2 when it stops on one.",
    ].join("\n"),
  },
});
