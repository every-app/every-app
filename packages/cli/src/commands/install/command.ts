import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, appTakeoverFlags, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

export const installCommand = buildCommand({
  loader: async () => {
    const { install } = await import(".");
    return install;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief:
            "The app release to install: a GitHub repository URL (its latest release), a release tarball's URL, or a downloaded everyapp-release.tar.gz",
          parse: String,
          placeholder: "source",
        },
      ],
    },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      ...appTakeoverFlags,
      "no-wait": {
        kind: "boolean",
        brief:
          "Don't wait for the app to go live (a new hostname's certificate included); the Gateway makes it live within a minute, or on its first visit",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief:
          "With no Gateway yet, install one at apps.<zone> without asking (never registers the providers the app bundles, cf's questions, or the one before replacing a Worker changed outside everyapp)",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Install an app someone published, from GitHub or a release file",
    fullDescription: [
      `Installs an app release on your Gateway with no checkout of the app, as ${CLI} deploy`,
      "would from the app's directory, with nothing to build: <source> is a GitHub repository URL",
      "(the everyapp-release.tar.gz on its latest release; …/releases/tag/<tag> for that one), a",
      "tarball's HTTPS URL, or a downloaded everyapp-release.tar.gz. The release holds the app's",
      "tenant-neutral Build Output, migrations and manifest, checked against its SHA-256. Run it",
      `again later to update the app. Its settings are set with ${CLI} configure <id>;`,
      ".everyapp/secrets.env in this directory is the deploy's own file, read only for a Hyperdrive",
      "app's database URL.",
      "",
      "A repository without a release is never built from its URL: clone it, run pnpm",
      `install in it, then ${CLI} deploy from its directory. Postgres migrations`,
      "need the app's source, so their releases are refused.",
      "",
      "No Gateway in any account the login sees, and none named? At a terminal it offers to install one at",
      `apps.<zone> (what ${CLI} setup does, owner link included), then installs the app; otherwise`,
      "it stops with action_required install_gateway and the setup command to run.",
      "--gateway <url> (or EVERYAPP_GATEWAY_URL) names the Gateway when your login sees several.",
      "With --json, each step is an NDJSON event.",
    ].join("\n"),
  },
});
