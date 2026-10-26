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
      yes: yesFlag,
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Update the Gateway to a newer release",
    fullDescription: [
      "Deploys a newer Gateway over the one your Cloudflare login finds, where it is, keeping its",
      "data, users and apps. It never installs a Gateway: with none, it stops and says to run",
      `${CLI} setup. The Gateway comes from --release (a GitHub repository or release URL, a`,
      "tarball's URL, or a downloaded every-app-gateway-release.tar.gz); otherwise this checkout's",
      "build when everyapp runs from one; otherwise the published release for this everyapp",
      "version (https://github.com/every-app/every-app, gateway-v<version>).",
      "",
      "  1. Logs in to Cloudflare (cf auth login, or CLOUDFLARE_API_TOKEN) and finds the Gateway in",
      "     the login's accounts (--account-id when there is one in more than one)",
      "  2. Upgrades it (migrations first, with a restore point). When it runs that Gateway",
      "     already, binds and publishes every registered app if the live Gateway doesn't, and",
      "     otherwise says it is up to date. A live Gateway newer than this one is refused (in a",
      "     checkout: git pull)",
      "",
      "A checkout's Gateway is named by its version when it is that version's release (the",
      "gateway-v<version> tag), and by the checkout's commit otherwise.",
      "With --json, each step is an NDJSON event.",
    ].join("\n"),
  },
});
