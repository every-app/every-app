import { describe, expect, it } from "vitest";
import { evaluateToolPolicy, roleReaches } from "./policy";

describe("evaluateToolPolicy", () => {
  it("hides destructive tools from everyone and write tools from read-only callers", () => {
    const write = { access: "write" as const };
    const read = { access: "read" as const };
    expect(evaluateToolPolicy({ risk: "read" }, read)).toEqual({
      action: "allow",
    });
    expect(evaluateToolPolicy({ risk: "write" }, write)).toEqual({
      action: "allow",
    });
    expect(evaluateToolPolicy({ risk: "write" }, read)).toEqual({
      action: "hide",
      reason: "read_only_connection",
    });
    for (const principal of [read, write]) {
      expect(evaluateToolPolicy({ risk: "destructive" }, principal)).toEqual({
        action: "hide",
        reason: "destructive_requires_approval",
      });
    }
  });

  it("hides a tool with a minRole below it, before the access rule: member < admin < owner", () => {
    const tool = { risk: "write" as const, minRole: "admin" as const };
    for (const [role, reaches] of [
      ["owner", true],
      ["admin", true],
      ["member", false],
      ["viewer", false],
      [undefined, false],
    ] as const) {
      expect(roleReaches(role, "admin"), String(role)).toBe(reaches);
      // A read-only admin is told the access reason; a member learns nothing
      // of the tool, read-only or not.
      expect(
        evaluateToolPolicy(tool, { access: "read", orgRole: role }),
        String(role),
      ).toEqual({
        action: "hide",
        reason: reaches ? "read_only_connection" : "role_required",
      });
      expect(
        evaluateToolPolicy(tool, { access: "write", orgRole: role }),
        String(role),
      ).toEqual(
        reaches
          ? { action: "allow" }
          : { action: "hide", reason: "role_required" },
      );
    }
    expect(roleReaches("admin", "owner")).toBe(false);
    expect(roleReaches("owner", "owner")).toBe(true);
    expect(roleReaches("member", "member")).toBe(true);
    // A tool without a minRole asks nothing of the role.
    expect(
      evaluateToolPolicy({ risk: "read" }, { access: "read", orgRole: "x" }),
    ).toEqual({ action: "allow" });
  });

  it("hides a tool with a minRole from a credential narrowed to apps, and nothing else from it", () => {
    const workspace = { risk: "read" as const, minRole: "member" as const };
    const narrowed = {
      access: "write" as const,
      orgRole: "owner",
      appScope: "selected" as const,
    };
    expect(evaluateToolPolicy(workspace, narrowed)).toEqual({
      action: "hide",
      reason: "app_scoped_credential",
    });
    // The role is read first: a member learns nothing either way.
    expect(
      evaluateToolPolicy(
        { ...workspace, minRole: "admin" },
        { ...narrowed, orgRole: "member" },
      ),
    ).toEqual({ action: "hide", reason: "role_required" });
    // An app's tools are the credential's to call; `all` and absent agree.
    expect(evaluateToolPolicy({ risk: "write" }, narrowed)).toEqual({
      action: "allow",
    });
    for (const appScope of ["all", undefined] as const) {
      expect(
        evaluateToolPolicy(workspace, { ...narrowed, appScope }),
        String(appScope),
      ).toEqual({ action: "allow" });
    }
  });

  it("treats an unannotated tool as write and lets the org block anything", () => {
    expect(evaluateToolPolicy({}, { access: "read" })).toMatchObject({
      action: "hide",
      reason: "read_only_connection",
    });
    expect(
      evaluateToolPolicy(
        { risk: "read" },
        { access: "write" },
        { blocked: true },
      ),
    ).toEqual({ action: "hide", reason: "org_blocked" });
  });
});
