import { buildCommand } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { jsonFlag } from "../flags";

export const createCommand = buildCommand({
  loader: async () => import("."),
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief:
            "An app name (lowercase letters, digits and dashes, e.g. my-app; asked for when missing), or the path of the folder to make, named after its last part (../my-app)",
          parse: String,
          placeholder: "name or path",
          optional: true,
        },
      ],
    },
    flags: {
      yes: {
        kind: "boolean",
        brief: "Don't ask anything (a name is then required)",
        optional: true,
      },
      json: jsonFlag,
      verbose: {
        kind: "boolean",
        brief: "Stream install and git output to stderr",
        optional: true,
      },
    },
    aliases: {
      y: "yes",
    },
  },
  docs: {
    brief: "Create a new app from the starter template",
    fullDescription: [
      "A bare name makes ./<name>; a path (../my-app, ~/apps/my-app) makes the app there,",
      "named after its last part. Each is its own git repository, its pnpm-lock.yaml in",
      "the first commit. Made by everyapp installed from npm, it is pinned to the published",
      "@every-app/sdk and everyapp; made from a checkout, it is linked to that checkout's,",
      "so its deploy runs the checkout's CLI.",
      "Dependencies are installed and the local database is ready, so `pnpm dev` works",
      "straight away. Then: cd into it and `pnpm run deploy`.",
      "",
      "Run from a checkout of the EveryApp repository, a bare name goes in apps/<name>",
      "(on the checkout's own packages); a path inside the checkout must be apps/<name>.",
      "",
      "Examples:",
      `  ${CLI} create my-app      ./my-app, its own repository`,
      `  ${CLI} create ~/apps/crm  ~/apps/crm, its own repository`,
    ].join("\n"),
  },
});
