import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { jsonFlag } from "../flags";

export const docsCommand = buildCommand({
  loader: async () => (await import(".")).docs,
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "page",
          brief: "The agent docs page: manifest, setup/openrouter, errors (a URL or .md works too); none lists them",
          parse: String,
          optional: true,
        },
      ],
    },
    flags: {
      offline: { kind: "boolean", optional: true, brief: "Read the copy bundled with this everyapp; don't try everyapp.com" },
      json: jsonFlag,
    },
  },
  docs: {
    brief: "Print a page of the agent docs, from everyapp.com or, offline, the copy bundled with everyapp",
    fullDescription: [
      "The agent docs are the reference coding agents answer from: every command, the --json",
      "protocol, every error code, everyapp.config.ts, and a setup guide per integration. They live",
      "at https://everyapp.com/docs/agent (https://everyapp.com/llms.txt lists them) and change",
      "without an everyapp upgrade. This prints one as Markdown: from the site when it answers,",
      "else from the copy this everyapp was built with (it says so; that copy may be older).",
      "",
      "Examples:",
      `  ${CLI} docs`,
      `  ${CLI} docs manifest`,
      `  ${CLI} docs setup/openrouter`,
      `  ${CLI} docs errors --offline`,
    ].join("\n"),
  },
});
