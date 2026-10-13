import { describe, expect, it } from "vitest";
import { evaluateToolPolicy } from "./policy";

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
