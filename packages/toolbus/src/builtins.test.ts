import { describe, expect, it } from "vitest";
import { BUILTIN_APP_ID, findBuiltinTool, listBuiltinTools } from "./builtins";
import {
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  splitNamespacedToolName,
} from "./names";
import { PRINCIPAL, todoApp } from "./test-fixtures";
import { gatewaySurfaceView } from "./view";

describe("the built-in tools", () => {
  const listed = listBuiltinTools().map((tool) => tool.name);

  it("are marked to load ahead of Claude Code's tool search", () => {
    const tools = listBuiltinTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool._meta, tool.name).toEqual({ "anthropic/alwaysLoad": true });
    }
  });

  it("stay read-only, argument-free and under everyapp", () => {
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

  it("are each listed as everyapp_<name>, within the namespaced name limit", () => {
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      const split = splitNamespacedToolName(name);
      expect(split?.appId, name).toBe(BUILTIN_APP_ID);
      const builtin = findBuiltinTool(split!.localName);
      expect(builtin?.name, name).toBe(split!.localName);
      expect(namespacedToolName(BUILTIN_APP_ID, builtin!.name)).toBe(name);
      expect(name.length, name).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    }
  });

  it("are the only everyapp_ tools the gateway's instructions name", () => {
    // Apps without guidance of their own, so every everyapp_ name in the
    // text is the gateway's: it must not send a client to a tool that
    // doesn't exist. The name grammar is names.ts's.
    const { instructions } = gatewaySurfaceView(
      { ...PRINCIPAL, organizationName: "Acme" },
      [todoApp({ instructions: undefined })],
      {
        unavailable: [{ appId: "crm", name: "CRM", reason: "needs setup" }],
      },
    );
    const named = [
      ...new Set(instructions!.match(/everyapp_[A-Za-z0-9_-]+/g) ?? []),
    ];
    expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((name) => !listed.includes(name));
    expect(
      unknown,
      "the gateway's instructions name a built-in tools/list doesn't have",
    ).toEqual([]);
  });
});
