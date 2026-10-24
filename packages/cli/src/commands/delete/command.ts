import { buildCommand } from "@stricli/core";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

export const deleteCommand = buildCommand({
  loader: async () => {
    const { deleteApp } = await import(".");
    return deleteApp;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "App id (default: the app in this directory)",
          parse: String,
          placeholder: "id",
          optional: true,
        },
      ],
    },
    flags: {
      gateway: gatewayFlag,
      "account-id": accountFlag,
      purge: {
        kind: "boolean",
        brief:
          "Also delete the app's Worker and helper Workers, D1 databases, KV namespaces, Workflows and Email Routing routes",
        optional: true,
      },
      yes: {
        kind: "boolean",
        brief:
          "Delete without asking (with --purge too, without typing the app id)",
        optional: true,
      },
      json: jsonFlag,
      verbose: verboseFlag,
    },
    aliases: { y: "yes" },
  },
  docs: {
    brief: "Remove an app from the Gateway",
    fullDescription: [
      "Deletes the app in the Gateway's D1 database (its name stays reserved; deploy it again to",
      "bring it back) and removes its Gateway binding and hostname, with a redeploy of the Gateway",
      "from this checkout.",
      "The app's Worker and data are kept unless --purge, which deletes them for good.",
      "Asks first at a terminal; elsewhere it needs --yes.",
    ].join("\n"),
  },
});
