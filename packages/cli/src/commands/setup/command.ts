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
      name: {
        kind: "parsed",
        parse: String,
        placeholder: "name",
        brief:
          "A second Gateway in the same Cloudflare account, by name (1 to 16 lowercase letters or digits): its Worker is every-app-gateway-<name> and its apps every-<name>--…; setup finds or installs that one only. Without it, the Gateway is every-app-gateway, as always",
        optional: true,
      },
      release: {
        kind: "parsed",
        parse: String,
        brief:
          "The Gateway release to deploy: a GitHub repository URL (its latest release) or release page, a release tarball's URL, or a downloaded every-app-gateway-release.tar.gz (default: this checkout's build, or without a checkout, the published release for this everyapp version)",
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
      "no-access": {
        kind: "boolean",
        brief:
          "Leave Cloudflare Access off (not recommended): by default setup puts it in front of the Gateway once the owner exists. Remembered, so a later unattended setup leaves it off too; everyapp access on turns it on",
        optional: true,
      },
      team: {
        kind: "parsed",
        parse: String,
        brief:
          "The Zero Trust team's name, when the Cloudflare account has none yet: people sign in at <name>.cloudflareaccess.com, and it can't be changed later (ignored once a team exists)",
        optional: true,
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
      `stopped, and does nothing once everything is there. ${CLI} update takes a newer Gateway`,
      "later (setup does that too, on its way).",
      "",
      "A fresh install takes 5 to 20 minutes, most of it waiting for you at the owner link: give it a",
      "long timeout, or run it in the background and watch its output.",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in",
      "     the login's accounts; with none, picks the account to install it in. A second Gateway",
      "     in the same account (staging, a demo) is --name <name>: every-app-gateway-<name>, with",
      "     its own database, queue and apps (every-<name>--…), beside the first, never touching it",
      "  2. Picks where the Gateway lives (--domain, or asked): any hostname under one of the",
      "     account's domains, apps.example.com; apps get one each below it, todo.apps.example.com",
      "  3. Installs the Gateway, or repairs it, and waits for its certificate. Where the Gateway",
      "     comes from: --release (a GitHub repository or release URL, a tarball's URL, or a",
      "     downloaded every-app-gateway-release.tar.gz); otherwise this checkout's build when",
      "     everyapp runs from one; otherwise the published release for this everyapp version",
      "     (https://github.com/every-app/every-app, gateway-v<version>)",
      "  4. Opens a one-time link to create the owner account and waits up to 15 minutes for it;",
      "     in CI there is no link, and the run ends with a warning to run setup at a terminal",
      "  5. Puts Cloudflare Access in front of the Gateway (asked at a terminal, Yes by default;",
      "     with --yes or --json, done without asking). An account with no Zero Trust team needs",
      "     its name: asked at a terminal, else --team. --no-access leaves it off (not recommended)",
      "",
      "The flags people use: --domain, --account-id, and --yes for a script (it answers setup's own",
      "questions; never cf's). With --json each step is an NDJSON event; a run that stops on",
      "something only a person can do exits 2 with action_required.",
      `Then: ${CLI} create ../my-app, cd into it, ${CLI} dev, ${CLI} deploy.`,
      "More: https://everyapp.com/docs/gateway",
    ].join("\n"),
  },
});
