/**
 * Tool policy v1. An app's declared risk is trusted as the default (the app
 * is the organization's own code); later org overrides may only tighten it.
 *
 *  - a tool with a `minRole` (the gateway's workspace tools) is hidden
 *    from a caller whose organization role is below it, and from a
 *    credential narrowed to apps (a personal token bound to one app, a
 *    connection consented to some): such a credential reaches those apps'
 *    tools and administers nothing;
 *  - destructive tools are hidden until approvals exist;
 *  - write tools are hidden from read-only callers;
 *  - a tool without a risk is treated as write.
 *
 * Hidden means absent from tools/list, and a call answers "Unknown tool", so
 * nothing about the tool leaks.
 */
import type { ToolRisk } from "@every-app/sdk/internal";
import type { McpAccess, McpPrincipal, WorkspaceRole } from "./types";

export type ToolPolicyDecision =
  | { action: "allow" }
  | {
      action: "hide";
      reason:
        | "role_required"
        | "app_scoped_credential"
        | "destructive_requires_approval"
        | "read_only_connection"
        | "org_blocked";
    };

/** The roles in order; a role the gateway doesn't know ranks below member. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

function roleRank(role: string | undefined): number {
  return role !== undefined && role in ROLE_RANK
    ? ROLE_RANK[role as WorkspaceRole]
    : -1;
}

/** Whether `role` reaches `minRole`: member < admin < owner. */
export function roleReaches(
  role: string | undefined,
  minRole: WorkspaceRole,
): boolean {
  return roleRank(role) >= ROLE_RANK[minRole];
}

export function evaluateToolPolicy(
  tool: { risk?: ToolRisk; minRole?: WorkspaceRole },
  principal: {
    access: McpAccess;
    orgRole?: string;
    appScope?: McpPrincipal["appScope"];
  },
  org?: { blocked?: boolean },
): ToolPolicyDecision {
  const risk = tool.risk ?? "write";
  if (org?.blocked) return { action: "hide", reason: "org_blocked" };
  if (tool.minRole && !roleReaches(principal.orgRole, tool.minRole)) {
    return { action: "hide", reason: "role_required" };
  }
  if (tool.minRole && principal.appScope === "selected") {
    return { action: "hide", reason: "app_scoped_credential" };
  }
  if (risk === "destructive") {
    return { action: "hide", reason: "destructive_requires_approval" };
  }
  if (risk === "write" && principal.access === "read") {
    return { action: "hide", reason: "read_only_connection" };
  }
  return { action: "allow" };
}
