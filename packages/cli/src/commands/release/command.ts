import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { jsonFlag, verboseFlag } from "../flags";

export const releaseCommand = buildCommand({
  loader: async () => {
    const { release } = await import(".");
    return release;
  },
  parameters: {
    positional: { kind: "tuple", parameters: [] },
    flags: {
      out: {
        kind: "parsed",
        parse: String,
        brief: "Where to write the release (default: ./everyapp-release.tar.gz)",
        placeholder: "file",
        optional: true,
      },
      publish: {
        kind: "boolean",
        brief:
          "In GitHub Actions, publish the release on GitHub: a push to the default branch as v<version>, a v* tag as itself, a manual run as a draft; a pull request publishes nothing",
        optional: true,
      },
      "dry-run": {
        kind: "boolean",
        brief: "With --publish, say which release it would publish, and publish nothing",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
  },
  docs: {
    brief: "Pack the app in this directory as a release others can install",
    fullDescription: [
      "Builds the app in this directory as a deploy would (tenant-neutral), checks its Build Output",
      "against the app policy and its migrations against its schema, and packs the release",
      "(default ./everyapp-release.tar.gz) without deploying it: no Gateway and no Cloudflare login,",
      "so it runs in CI. Attach the tarball to a GitHub release of the app's repository, and",
      `${CLI} install <repository url> installs it on any Gateway.`,
      "With --publish (in the app repository's Release workflow) it then publishes the tarball on",
      "a GitHub release of the repository the run builds, from GITHUB_REPOSITORY, GITHUB_SHA,",
      "GITHUB_EVENT_NAME, GITHUB_REF_* and GITHUB_TOKEN: v<package.json version> on a push to the",
      "default branch (v<version>-<yyyymmdd>-<sha7> when that tag exists), the pushed tag on a v* tag,",
      "a draft on workflow_dispatch, nothing on a pull request. --dry-run plans it and publishes nothing.",
      "With --json, each step is an NDJSON event; done carries the tarball's path and SHA-256",
      "(and the release published).",
    ].join("\n"),
  },
});
