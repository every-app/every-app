import { buildCommand } from "@stricli/core";
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
      "A path (../my-app, ~/apps/my-app) makes the app there, named after its last part:",
      "outside your Every App checkout it is its own git repository, linked to the checkout;",
      "inside it only apps/<name> is allowed. A bare name goes in apps/<name> when run from",
      "the checkout, in ./<name> anywhere else. Dependencies are installed and the local",
      "database is ready, so `pnpm dev` works straight away. Then: cd into it and",
      "`pnpm run deploy`.",
      "",
      "Examples:",
      "  pnpm everyapp create ../my-app    beside the checkout, its own repository",
      "  pnpm everyapp create analytics    apps/analytics, from the checkout",
    ].join("\n"),
  },
});
