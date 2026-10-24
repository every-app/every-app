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
      "With --json, each step is an NDJSON event; done carries the tarball's path and SHA-256.",
    ].join("\n"),
  },
});
