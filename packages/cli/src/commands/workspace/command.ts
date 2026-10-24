import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

/** The flags every `workspace` command takes: the Gateway's, and the output's. */
const connectFlags = {
  gateway: gatewayFlag,
  "account-id": accountFlag,
  json: jsonFlag,
  verbose: verboseFlag,
} as const;

const renameCommand = buildCommand({
  loader: async () => {
    const { rename } = await import(".");
    return rename;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "name",
          brief: "The new name: 1 to 64 characters, no line breaks (quote one with spaces)",
          parse: String,
        },
      ],
    },
    flags: connectFlags,
  },
  docs: {
    brief: "Rename the workspace: the name members see in the organization switcher and in invitations",
    fullDescription: [
      "The workspace is the Gateway's organization: the one the setup claim made, named after",
      "its owner. This gives it the name you want; the same rename is under Manage workspace in",
      "the Gateway, for owners and admins. Nothing is built or deployed: the Gateway reads the",
      "name live, and each member sees it on their next page.",
      "",
      "Before the Gateway is claimed there is no workspace to rename (WORKSPACE_NOT_CLAIMED):",
      "claim it in a browser first.",
      "",
      "Examples:",
      `  ${CLI} workspace rename 'Acme Corp'`,
      `  ${CLI} workspace rename 'Acme Corp' --json`,
    ].join("\n"),
  },
});

// One route per command: a sibling adds `role <email> <role>` here.
export const workspaceRoutes = buildRouteMap({
  routes: { rename: renameCommand },
  docs: {
    brief: "Rename the workspace and set members' roles",
  },
});
