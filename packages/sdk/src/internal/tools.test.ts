import { describe, expect, it } from "vitest";
import {
  MCP_DESTRUCTIVE_SCOPE,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
  TOOL_NAME_PATTERN,
  canonicalJson,
  catalogHash,
  isToolRisk,
  requiredScopeForRisk,
  type ToolDescriptorV1,
} from "./tools";

const LIST: ToolDescriptorV1 = {
  name: "list_todos",
  description: "List todos",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
};

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
    ).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it("drops undefined members like JSON.stringify", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("catalogHash", () => {
  it("is stable under key order and sensitive to content", async () => {
    const reordered = {
      inputSchema: { properties: {}, type: "object" },
      risk: "read",
      description: "List todos",
      name: "list_todos",
    } as ToolDescriptorV1;
    const base = await catalogHash({ tools: [LIST] });

    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await catalogHash({ tools: [reordered] })).toBe(base);
    expect(await catalogHash({ tools: [{ ...LIST, risk: "write" }] })).not.toBe(
      base,
    );
    expect(
      await catalogHash({ instructions: "Be careful", tools: [LIST] }),
    ).not.toBe(base);
  });
});

describe("risk scopes", () => {
  it("maps each risk to its own explicit scope", () => {
    expect(requiredScopeForRisk("read")).toBe(MCP_READ_SCOPE);
    expect(requiredScopeForRisk("write")).toBe(MCP_WRITE_SCOPE);
    expect(requiredScopeForRisk("destructive")).toBe(MCP_DESTRUCTIVE_SCOPE);
    expect(isToolRisk("write")).toBe(true);
    expect(isToolRisk("admin")).toBe(false);
    expect(isToolRisk(undefined)).toBe(false);
  });
});

describe("tool names", () => {
  it("accepts lowercase snake_case up to 48 characters", () => {
    expect(TOOL_NAME_PATTERN.test("list_todos")).toBe(true);
    expect(TOOL_NAME_PATTERN.test("a".repeat(48))).toBe(true);
    for (const bad of [
      "a".repeat(49),
      "ListTodos",
      "list-todos",
      "_list",
      "1list",
      "list.todos",
      "",
    ]) {
      expect(TOOL_NAME_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
