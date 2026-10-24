import { describe, expect, it } from "vitest";
import { BUILTIN_APP_ID, listBuiltinTools } from "./builtins";

describe("listBuiltinTools", () => {
  it("marks every built-in to load ahead of Claude Code's tool search", () => {
    const tools = listBuiltinTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool._meta, tool.name).toEqual({ "anthropic/alwaysLoad": true });
    }
  });

  it("keeps every built-in read-only, argument-free and under everyapp", () => {
    for (const tool of listBuiltinTools()) {
      expect(tool.name.startsWith(`${BUILTIN_APP_ID}_`), tool.name).toBe(true);
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema, tool.name).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
    }
  });
});
