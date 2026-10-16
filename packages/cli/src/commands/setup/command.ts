import { buildCommand } from "@stricli/core";
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
          "Where the Gateway lives: any hostname in a zone the account has, e.g. apps.example.com (asked at a terminal; its install row keeps it after that)",
        optional: true,
      },
      mode: {
        kind: "enum",
        values: ["self_hosted", "hosted"],
        brief:
          "What a new Gateway is: self_hosted (your own install, the default) or hosted (open sign-up, shared first-party apps); set once, at install",
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
          "Deploy this checkout's Gateway even though it is older than the live one (a deliberate rollback)",
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
    brief: "Install, upgrade or repair the Gateway in your Cloudflare account",
    fullDescription: [
      "One command from an empty Cloudflare account to a working Gateway and its owner, and the",
      "one to run after a git pull or when something is off. Run it again any time: it picks up",
      "where it stopped, and does nothing once everything is there. The Gateway is built from this",
      "checkout. Your Cloudflare login is the only credential: apps deploy with it, on this machine",
      "or any other, even before the Gateway has an owner.",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in",
      "     the login's accounts; with none, picks the account to install it in",
      "  2. Checks for Workers Paid, which Every App needs (a warning, not a question)",
      "  3. Picks where the Gateway lives: any hostname in a zone the account has (apps.example.com);",
      "     apps get one each below it (todo.apps.example.com), with their own DNS and certificate",
      "  4. Installs the Gateway, or upgrades it to the release this checkout builds (migrations",
      "     first, with a restore point), and waits for its certificate. When it runs that release",
      "     already, binds and publishes every registered app if the live Gateway doesn't, and",
      "     otherwise says it is up to date. A checkout behind the live Gateway is refused: git pull",
      "  5. Opens a one-time link to create the owner account, and waits up to 15 minutes for it",
      "     (in CI it only says to run setup on your machine); a run resumed later shows a new",
      "     link, and the earlier one stops working",
      "",
      "--mode hosted installs the hosted Gateway instead (docs/runbooks/hosted-install.md); the",
      "mode is set with the first upload and never changes after.",
      "",
      "Then: everyapp create my-app, cd into it, everyapp dev, everyapp deploy.",
      "No domain on Cloudflare yet? Buy one in the dashboard (Domains → Buy a domain), then run it again.",
      "Nothing asks for a go-ahead: the first lines say which account and where. The Gateway's",
      "build output goes to a log file, never to stdout.",
      "With --json, each step is an NDJSON event; what a person must do is `action_required`",
      "(with its link and code), and the run exits 2 when it stops on one.",
    ].join("\n"),
  },
});
