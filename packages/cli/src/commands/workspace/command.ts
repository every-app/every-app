import { buildCommand, buildRouteMap } from "@stricli/core";
import { CLI } from "@/lib/output/command";
import { accountFlag, gatewayFlag, jsonFlag, verboseFlag } from "../flags";

/** A member's role in the workspace, as `workspace role` sets it. */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export function parseWorkspaceRole(value: string): WorkspaceRole {
  const role = WORKSPACE_ROLES.find((name) => name === value.trim().toLowerCase());
  if (!role) throw new Error("Use owner, admin or member.");
  return role;
}

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

const roleCommand = buildCommand({
  loader: async () => {
    const { role } = await import(".");
    return role;
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          placeholder: "email",
          brief: "The member's email address, as Manage workspace → Users lists it",
          parse: String,
        },
        {
          placeholder: "owner|admin|member",
          brief: "The role to give them",
          parse: parseWorkspaceRole,
        },
      ],
    },
    flags: connectFlags,
  },
  docs: {
    brief: "Set a member's role: owner, admin or member",
    fullDescription: [
      "The workspace is the Gateway's own organization, the one its owner claimed. Owners are",
      "peers: any owner can make a member or an admin an owner, and change another owner's",
      "role, from Manage workspace → Users or with this command under the Cloudflare login.",
      "The workspace always keeps at least one owner, so the last owner's role is never",
      "changed (LAST_OWNER): make someone else an owner first. Deactivated owners don't",
      "count here, so this command can't leave a workspace whose only owner is locked out",
      "(the Gateway's own Users page needs no such rule: a deactivated owner can't act, and",
      "only an owner acts on an owner). Only a member can be given a role; someone still",
      "invited isn't one yet (MEMBER_NOT_FOUND). The Gateway picks up the change within 30",
      "seconds.",
      "",
      "Examples:",
      `  ${CLI} workspace role sam@example.com owner`,
      `  ${CLI} workspace role sam@example.com member --json`,
    ].join("\n"),
  },
});

export const workspaceRoutes = buildRouteMap({
  routes: { rename: renameCommand, role: roleCommand },
  docs: {
    brief: "Rename the workspace and set members' roles",
  },
});
