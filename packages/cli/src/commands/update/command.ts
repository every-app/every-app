import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, forceDnsFlag, jsonFlag, verboseFlag, yesFlag } from "../flags";

export const updateCommand = buildCommand({
  loader: async () => {
    const { update } = await import(".");
    return update;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      "account-id": accountFlag,
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
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Update the Gateway to this checkout (after git pull)",
    fullDescription: [
      "Deploys the Gateway built from this checkout (apps/every-app-gateway) over the one your",
      "Cloudflare login finds, where it is, keeping its data, users and apps. It never installs a",
      `Gateway: with none, it stops and says to run ${CLI} setup.`,
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in",
      "     the login's accounts (--account-id when there is one in more than one)",
      "  2. Upgrades it (migrations first, with a restore point). When it runs this checkout's",
      "     Gateway already, binds and publishes every registered app if the live Gateway doesn't,",
      "     and otherwise says it is up to date. A Gateway newer than this checkout is refused",
      "     (git pull)",
      "",
      "The release is named by its version when this checkout's Gateway is that version's release",
      "(the gateway-v<version> tag), and by the checkout's commit otherwise.",
      "With --json, each step is an NDJSON event.",
    ].join("\n"),
  },
});
