/**
 * The MCP app tools (`everyapp_mcp_*`) as the ToolBus lists and runs
 * them: the eight the design names, workspace tools like the rest (kind
 * `host`, listed in full mode to owners and admins, `mcp_remove` with
 * confirm), closed schemas that take a credential's name and
 * never its value, hidden from a member and from a read-only connection's
 * writes. What each one does is the gateway's
 * (server/toolbus/mcp-app-tools.sqlite.test.ts there).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { builtinToolKind, listBuiltinTools } from "./builtins";
import { createArgumentsDigester } from "./digest";
import { executeToolCall } from "./execute";
import { MCP_APP_TOOLS } from "./mcpApps";
import { listTools } from "./server";
import {
  ISSUER,
  PRINCIPAL,
  gatewayView,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type {
  JsonObject,
  McpPrincipal,
  ToolBusDeps,
  ToolCallAuditEvent,
} from "./types";
import { WORKSPACE_TOOLS } from "./workspace";

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

const MEMBER: McpPrincipal = { ...PRINCIPAL, orgRole: "member" };
const ADMIN: McpPrincipal = { ...PRINCIPAL, orgRole: "admin" };
const OWNER: McpPrincipal = { ...PRINCIPAL, orgRole: "owner" };
const readOnly = (principal: McpPrincipal): McpPrincipal => ({
  ...principal,
  access: "read",
});

const NAMES = MCP_APP_TOOLS.map((tool) => `everyapp_${tool.name}`);
const definition = (name: string) =>
  MCP_APP_TOOLS.find((tool) => tool.name === name)!;
const properties = (name: string) =>
  definition(name).inputSchema["properties"] as Record<
    string,
    Record<string, unknown>
  >;

/** The MCP app tools a caller is listed, in full mode, with a host. */
function listed(principal: McpPrincipal, listing: "full" | "compact" = "full") {
  return listBuiltinTools({ principal, listing }, { workspace: true })
    .map((tool) => tool.name)
    .filter((name) => NAMES.includes(name));
}

function harness() {
  const calls: { name: string; args: JsonObject }[] = [];
  const events: ToolCallAuditEvent[] = [];
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async () => Response.json({}),
    workspace: {
      run: async (name, args) => {
        calls.push({ name, args });
        return {
          content: [{ type: "text", text: name }],
          structuredContent: { name },
        };
      },
    },
    audit: (event) => events.push(event),
    digestArguments: createArgumentsDigester("secret", "test"),
  };
  return { deps, calls, events };
}

describe("the MCP app tool definitions", () => {
  it("are the eight the design names, workspace tools listed after the others", () => {
    expect(MCP_APP_TOOLS.map((tool) => tool.name)).toEqual([
      "mcp_list",
      "mcp_show",
      "mcp_add",
      "mcp_remove",
      "mcp_on",
      "mcp_off",
      "mcp_refresh",
      "mcp_tool",
    ]);
    expect(WORKSPACE_TOOLS.slice(-MCP_APP_TOOLS.length)).toEqual(MCP_APP_TOOLS);
    for (const name of NAMES) {
      expect(builtinToolKind(name), name).toBe("host");
    }
  });

  it("are owners' and admins': reads for list and show, writes for the rest, remove irreversible", () => {
    const shape = MCP_APP_TOOLS.map((tool) => [
      tool.name,
      tool.minRole,
      tool.risk,
      tool.irreversible ?? false,
    ]);
    expect(shape).toEqual([
      ["mcp_list", "admin", "read", false],
      ["mcp_show", "admin", "read", false],
      ["mcp_add", "admin", "write", false],
      ["mcp_remove", "admin", "write", true],
      ["mcp_on", "admin", "write", false],
      ["mcp_off", "admin", "write", false],
      ["mcp_refresh", "admin", "write", false],
      ["mcp_tool", "admin", "write", false],
    ]);
    for (const tool of MCP_APP_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
      // Each says who may call it.
      expect(tool.description, tool.name).toMatch(/Owners and admins\.$/);
    }
    expect(properties("mcp_remove")["confirm"]).toMatchObject({
      type: "boolean",
      const: true,
    });
    expect(definition("mcp_remove").inputSchema["required"]).toEqual([
      "app",
      "confirm",
    ]);
  });

  it("take a credential's setting name and never its value: closed schemas, the kinds and risks as enums", () => {
    const add = properties("mcp_add");
    expect(Object.keys(add)).toEqual([
      "url",
      "id",
      "name",
      "description",
      "auth",
      "risk",
    ]);
    expect(definition("mcp_add").inputSchema["required"]).toEqual([
      "url",
      "auth",
    ]);
    const auth = add["auth"]!;
    expect(auth).toMatchObject({
      type: "object",
      required: ["kind"],
      additionalProperties: false,
    });
    expect(Object.keys(auth["properties"] as Record<string, unknown>)).toEqual([
      "kind",
      "secret",
      "header",
      "prefix",
    ]);
    expect(
      (auth["properties"] as Record<string, Record<string, unknown>>)["kind"],
    ).toMatchObject({ enum: ["none", "bearer", "header", "basic", "oauth"] });
    expect(
      (auth["properties"] as Record<string, Record<string, unknown>>)[
        "secret"
      ]!["description"],
    ).toContain("Never the credential itself");
    expect(add["risk"]).toMatchObject({
      enum: ["annotations", "read", "write"],
    });
    expect(properties("mcp_tool")["risk"]).toMatchObject({
      enum: ["read", "write", "destructive", "annotations"],
    });
    expect(properties("mcp_tool")["enabled"]).toMatchObject({
      type: "boolean",
    });
    // No field anywhere is named for a value.
    const fields = JSON.stringify(
      MCP_APP_TOOLS.map((tool) => tool.inputSchema),
    );
    for (const word of ['"token"', '"value"', '"password"', '"apiKey"']) {
      expect(fields).not.toContain(word);
    }
    // mcp_list takes nothing; the others name the app.
    expect(definition("mcp_list").inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    for (const name of ["mcp_show", "mcp_on", "mcp_off", "mcp_refresh"]) {
      expect(definition(name).inputSchema["required"], name).toEqual(["app"]);
    }
    expect(definition("mcp_tool").inputSchema["required"]).toEqual([
      "app",
      "tool",
    ]);
  });
});

describe("who sees the MCP app tools", () => {
  it("lists all eight to an owner and to an admin in full mode, none in compact mode", () => {
    expect(listed(OWNER)).toEqual(NAMES);
    expect(listed(ADMIN)).toEqual(NAMES);
    expect(listed(OWNER, "compact")).toEqual([]);
    // Deferred behind Claude Code's tool search like the other workspace
    // tools, and remove says it can't be undone.
    const tools = listTools(gatewayView([todoApp()], OWNER), {
      workspace: true,
    });
    const remove = tools.find((tool) => tool.name === "everyapp_mcp_remove")!;
    expect(remove._meta).toBeUndefined();
    expect(remove.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(
      tools.find((tool) => tool.name === "everyapp_mcp_list")!.annotations,
    ).toMatchObject({ readOnlyHint: true });
  });

  it("lists a member none and a read-only admin list and show alone", () => {
    expect(listed(MEMBER)).toEqual([]);
    expect(listed(readOnly(MEMBER))).toEqual([]);
    expect(listed(readOnly(ADMIN))).toEqual([
      "everyapp_mcp_list",
      "everyapp_mcp_show",
    ]);
    expect(listed(readOnly(OWNER))).toEqual([
      "everyapp_mcp_list",
      "everyapp_mcp_show",
    ]);
  });

  it("answers Unknown tool to a member and to a read-only connection for a write, never running the host", async () => {
    const { deps, calls, events } = harness();
    const cases: [McpPrincipal, string, JsonObject, string][] = [
      [MEMBER, "everyapp_mcp_list", {}, "role_required"],
      [
        MEMBER,
        "everyapp_mcp_add",
        { url: "https://x.example/mcp", auth: { kind: "none" } },
        "role_required",
      ],
      [
        readOnly(ADMIN),
        "everyapp_mcp_add",
        { url: "https://x.example/mcp", auth: { kind: "none" } },
        "read_only_connection",
      ],
      [
        readOnly(ADMIN),
        "everyapp_mcp_off",
        { app: "treg" },
        "read_only_connection",
      ],
    ];
    for (const [principal, name, args, reason] of cases) {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], principal),
        { name, arguments: args },
        deps,
      );
      expect(resolution, `${principal.orgRole} ${name}`).toEqual({
        kind: "unknown_tool",
      });
      expect(events.at(-1), name).toMatchObject({
        tool: name,
        appId: "everyapp",
        decision: "blocked",
        reason,
      });
    }
    expect(calls).toEqual([]);
    // A read-only admin runs the reads.
    const shown = await executeToolCall(
      gatewayView([todoApp()], readOnly(ADMIN)),
      { name: "everyapp_mcp_show", arguments: { app: "treg" } },
      deps,
    );
    expect(shown.kind).toBe("result");
    expect(calls).toEqual([{ name: "mcp_show", args: { app: "treg" } }]);
  });

  it("refuses a credential value before the host sees it: an unknown auth field, remove without confirm", async () => {
    const { deps, calls } = harness();
    const view = gatewayView([todoApp()], OWNER);
    const text = async (name: string, args: JsonObject) => {
      const resolution = await executeToolCall(
        view,
        { name, arguments: args },
        deps,
      );
      if (resolution.kind !== "result") return resolution.kind;
      const [block] = resolution.result.content;
      return block?.type === "text" ? block["text"] : "";
    };
    expect(
      await text("everyapp_mcp_add", {
        url: "https://treg.to/mcp",
        auth: { kind: "bearer", token: "sk-live-123" },
      }),
    ).toMatch(/^Invalid arguments for everyapp_mcp_add: /);
    expect(
      await text("everyapp_mcp_add", {
        url: "https://treg.to/mcp",
        auth: { kind: "bearer" },
        token: "sk-live-123",
      }),
    ).toMatch(/^Invalid arguments for everyapp_mcp_add: /);
    expect(
      await text("everyapp_mcp_add", {
        url: "https://treg.to/mcp",
        auth: { kind: "magic" },
      }),
    ).toMatch(/^Invalid arguments for everyapp_mcp_add: /);
    expect(await text("everyapp_mcp_remove", { app: "treg" })).toMatch(
      /^Invalid arguments for everyapp_mcp_remove: /,
    );
    expect(
      await text("everyapp_mcp_tool", { app: "treg", tool: "x", risk: "safe" }),
    ).toMatch(/^Invalid arguments for everyapp_mcp_tool: /);
    expect(calls).toEqual([]);
  });
});
