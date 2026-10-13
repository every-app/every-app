/**
 * Tool policy v1. An app's declared risk is trusted as the default (the app
 * is the organization's own code); later org overrides may only tighten it.
 *
 *  - destructive tools are hidden until approvals exist;
 *  - write tools are hidden from read-only callers;
 *  - a tool without a risk is treated as write.
 *
 * Hidden means absent from tools/list, and a call answers "Unknown tool", so
 * nothing about the tool leaks.
 */
import type { ToolRisk } from "@every-app/sdk/internal";
import type { McpAccess } from "./types";

export type ToolPolicyDecision =
  | { action: "allow" }
  | {
      action: "hide";
      reason:
        | "destructive_requires_approval"
        | "read_only_connection"
        | "org_blocked";
    };

export function evaluateToolPolicy(
  tool: { risk?: ToolRisk },
  principal: { access: McpAccess },
  org?: { blocked?: boolean },
): ToolPolicyDecision {
  const risk = tool.risk ?? "write";
  if (org?.blocked) return { action: "hide", reason: "org_blocked" };
  if (risk === "destructive") {
    return { action: "hide", reason: "destructive_requires_approval" };
  }
  if (risk === "write" && principal.access === "read") {
    return { action: "hide", reason: "read_only_connection" };
  }
  return { action: "allow" };
}
