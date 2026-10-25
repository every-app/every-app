/**
 * The provider tools (providers.ts): three host-kind built-ins beside the
 * workspace tools. The list is every member's; the two writers are owners'
 * and admins', and only where the host registers providers
 * (`WorkspaceHost.providers`): elsewhere they are absent from tools/list
 * and from the search, and a call answers Unknown tool, like a tool
 * without a host.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { builtinToolKind, listBuiltinTools } from "./builtins";
import { createArgumentsDigester } from "./digest";
import { executeToolCall } from "./execute";
import { PROVIDER_TOOLS } from "./providers";
import {
  gatewayView,
  ISSUER,
  PRINCIPAL,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type {
  JsonObject,
  McpPrincipal,
  ToolBusDeps,
  ToolCallAuditEvent,
  WorkspaceHost,
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
const listed = (name: string) => `everyapp_${name}`;
const PROVIDER_NAMES = PROVIDER_TOOLS.map((tool) => listed(tool.name));

/** A host that records every call, registering providers or not. */
function harness(providers?: boolean) {
  const calls: { name: string; args: JsonObject; principal: McpPrincipal }[] =
    [];
  const events: ToolCallAuditEvent[] = [];
  const workspace: WorkspaceHost = {
    run: async (name, args, principal) => {
      calls.push({ name, args, principal });
      return {
        content: [{ type: "text", text: JSON.stringify({ name, args }) }],
        structuredContent: { name, args },
      };
    },
    ...(providers === undefined ? {} : { providers }),
  };
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async () => Response.json({}),
    workspace,
    audit: (event) => events.push(event),
    digestArguments: createArgumentsDigester("secret", "test"),
  };
  return { deps, calls, events };
}

describe("the provider tool definitions", () => {
  it("are the three the design names: the list for any member, add and remove for admins where the host registers providers", () => {
    expect(
      PROVIDER_TOOLS.map((tool) => [
        tool.name,
        tool.risk,
        tool.minRole,
        tool.needs ?? null,
      ]),
    ).toEqual([
      ["provider_list", "read", "member", null],
      ["provider_add", "write", "admin", "providers"],
      ["provider_remove", "write", "admin", "providers"],
    ]);
    for (const tool of PROVIDER_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(tool.irreversible, tool.name).toBeUndefined();
      expect(builtinToolKind(listed(tool.name))).toBe("host");
    }
    // Named apart from the workspace tools.
    for (const tool of WORKSPACE_TOOLS) {
      expect(tool.name.startsWith("provider_"), tool.name).toBe(false);
    }
  });

  it("keep the schemas closed, every field described, with no regex, reference or union; add takes the spec object alone, remove the id alone", () => {
    const forbidden = ["pattern", "$ref", "anyOf", "oneOf", "allOf", "not"];
    for (const tool of PROVIDER_TOOLS) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema["type"], tool.name).toBe("object");
      expect(schema["additionalProperties"], tool.name).toBe(false);
      for (const [field, definition] of Object.entries(
        (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>,
      )) {
        expect(typeof definition["description"], `${tool.name}.${field}`).toBe(
          "string",
        );
        for (const key of forbidden) {
          expect(
            definition,
            `${tool.name}.${field} uses ${key}`,
          ).not.toHaveProperty(key);
        }
      }
    }
    const add = PROVIDER_TOOLS.find((tool) => tool.name === "provider_add")!;
    expect(Object.keys(add.inputSchema["properties"] as object)).toEqual([
      "spec",
    ]);
    expect(add.inputSchema["required"]).toEqual(["spec"]);
    expect(
      (add.inputSchema["properties"] as Record<string, unknown>)["spec"],
    ).toMatchObject({ type: "object" });
    const remove = PROVIDER_TOOLS.find(
      (tool) => tool.name === "provider_remove",
    )!;
    expect(Object.keys(remove.inputSchema["properties"] as object)).toEqual([
      "id",
    ]);
    expect(remove.inputSchema["required"]).toEqual(["id"]);
  });
});

describe("listing the provider tools", () => {
  const names = (
    principal: McpPrincipal,
    host: { workspace?: boolean; providers?: boolean },
    listing: "full" | "compact" = "full",
  ) =>
    listBuiltinTools({ principal, listing }, host)
      .map((tool) => tool.name)
      .filter((name) => PROVIDER_NAMES.includes(name));

  it("lists the writers to owners and admins only where the host registers providers, the list to every member, and none in compact mode or without a host", () => {
    const registering = { workspace: true, providers: true };
    expect(names(OWNER, registering)).toEqual(PROVIDER_NAMES);
    expect(names(ADMIN, registering)).toEqual(PROVIDER_NAMES);
    expect(names(MEMBER, registering)).toEqual(["everyapp_provider_list"]);
    expect(names(readOnly(ADMIN), registering)).toEqual([
      "everyapp_provider_list",
    ]);
    // A host that runs the workspace tools but registers no providers (a
    // hosted gateway): the list alone, whatever the role.
    expect(names(OWNER, { workspace: true })).toEqual([
      "everyapp_provider_list",
    ]);
    expect(names(OWNER, { workspace: true, providers: false })).toEqual([
      "everyapp_provider_list",
    ]);
    // Without a host, nothing; in compact mode, nothing (the search finds them).
    expect(names(OWNER, {})).toEqual([]);
    expect(names(OWNER, { providers: true })).toEqual([]);
    expect(names(OWNER, registering, "compact")).toEqual([]);
    // A credential narrowed to apps sees none, whatever the role.
    expect(names({ ...OWNER, appScope: "selected" }, registering)).toEqual([]);
    // No view (the docs' drift test) lists all three, after the workspace tools.
    const every = listBuiltinTools().map((tool) => tool.name);
    expect(every.slice(-PROVIDER_NAMES.length)).toEqual(PROVIDER_NAMES);
  });
});

describe("running a provider tool", () => {
  it("runs the writers for an admin where the host registers providers, as unknown where it doesn't, and the list anywhere the host runs the tools", async () => {
    const registering = harness(true);
    const spec = { id: "stripe", name: "Stripe" };
    const added = await executeToolCall(
      gatewayView([todoApp()], ADMIN),
      { name: "everyapp_provider_add", arguments: { spec } },
      registering.deps,
    );
    expect(added.kind).toBe("result");
    expect(registering.calls).toEqual([
      { name: "provider_add", args: { spec }, principal: ADMIN },
    ]);
    expect(registering.events.at(-1)).toMatchObject({
      tool: "everyapp_provider_add",
      appId: "everyapp",
      decision: "allowed",
      outcome: "ok",
    });

    // The same call on a host that registers no providers: Unknown tool,
    // audited blocked, the host never asked.
    for (const providers of [undefined, false]) {
      const hosted = harness(providers);
      const resolution = await executeToolCall(
        gatewayView([todoApp()], OWNER),
        { name: "everyapp_provider_add", arguments: { spec } },
        hosted.deps,
      );
      expect(resolution, String(providers)).toEqual({ kind: "unknown_tool" });
      expect(hosted.calls).toEqual([]);
      expect(hosted.events.at(-1)).toMatchObject({
        tool: "everyapp_provider_add",
        decision: "blocked",
        reason: "unknown_tool",
        outcome: "not_run",
      });
      // The list still runs there, for a member too.
      const list = await executeToolCall(
        gatewayView([todoApp()], MEMBER),
        { name: "everyapp_provider_list", arguments: {} },
        hosted.deps,
      );
      expect(list.kind).toBe("result");
      expect(hosted.calls).toEqual([
        { name: "provider_list", args: {}, principal: MEMBER },
      ]);
    }
  });

  it("refuses a member and a read-only connection the writers as unknown, and the schema before the host: never a URL, never a replace flag", async () => {
    const { deps, calls, events } = harness(true);
    const cases: [McpPrincipal, string, string][] = [
      [MEMBER, "everyapp_provider_add", "role_required"],
      [MEMBER, "everyapp_provider_remove", "role_required"],
      [readOnly(ADMIN), "everyapp_provider_add", "read_only_connection"],
      [readOnly(OWNER), "everyapp_provider_remove", "read_only_connection"],
    ];
    for (const [principal, name, reason] of cases) {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], principal),
        { name, arguments: { spec: {}, id: "stripe" } },
        deps,
      );
      expect(resolution, `${principal.orgRole} ${name}`).toEqual({
        kind: "unknown_tool",
      });
      expect(events.at(-1), name).toMatchObject({
        decision: "blocked",
        reason,
      });
    }
    expect(calls).toEqual([]);
    // The tool's own schema: a URL in place of the spec, a replace flag,
    // and a remove without an id are refused before the host is asked.
    for (const [name, args] of [
      ["everyapp_provider_add", { spec: "https://example.com/stripe.json" }],
      ["everyapp_provider_add", { spec: {}, replace: true }],
      ["everyapp_provider_add", {}],
      ["everyapp_provider_remove", {}],
      ["everyapp_provider_remove", { id: "x" }],
      ["everyapp_provider_remove", { id: "stripe", force: true }],
    ] as const) {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], OWNER),
        { name, arguments: args as JsonObject },
        deps,
      );
      expect(resolution.kind, name).toBe("result");
      if (resolution.kind !== "result") throw new Error(resolution.kind);
      expect(resolution.result.isError, `${name} ${JSON.stringify(args)}`).toBe(
        true,
      );
      expect(resolution.result.content[0]).toMatchObject({
        text: expect.stringMatching(`^Invalid arguments for ${name}: `),
      });
    }
    expect(calls).toEqual([]);
  });

  it("is found by everyapp_search_tools by the caller's role and the host's facility, and runs through everyapp_call_write", async () => {
    const search = async (
      principal: McpPrincipal,
      deps: ToolBusDeps,
      query: JsonObject,
    ) => {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], principal, undefined, "compact"),
        { name: "everyapp_search_tools", arguments: { limit: 25, ...query } },
        deps,
      );
      if (resolution.kind !== "result") throw new Error(resolution.kind);
      return (
        resolution.result.structuredContent as { tools: { name: string }[] }
      ).tools
        .map((tool) => tool.name)
        .filter((name) => PROVIDER_NAMES.includes(name));
    };
    const registering = harness(true);
    const hosted = harness(false);
    // The search answers by name.
    expect(
      await search(ADMIN, registering.deps, { query: "provider" }),
    ).toEqual([...PROVIDER_NAMES].sort());
    expect(
      await search(MEMBER, registering.deps, { query: "provider" }),
    ).toEqual(["everyapp_provider_list"]);
    expect(await search(ADMIN, hosted.deps, { query: "provider" })).toEqual([
      "everyapp_provider_list",
    ]);
    // Through the write wrapper, in compact mode: one row naming the tool.
    const wrapped = await executeToolCall(
      gatewayView([todoApp()], ADMIN, undefined, "compact"),
      {
        name: "everyapp_call_write",
        arguments: {
          name: "everyapp_provider_remove",
          arguments: { id: "stripe" },
        },
      },
      registering.deps,
    );
    expect(wrapped.kind).toBe("result");
    expect(registering.calls).toEqual([
      { name: "provider_remove", args: { id: "stripe" }, principal: ADMIN },
    ]);
    expect(registering.events.at(-1)).toMatchObject({
      tool: "everyapp_provider_remove",
      via: "everyapp_call_write",
      decision: "allowed",
      outcome: "ok",
    });
    // And on the hosted host the wrapper answers Unknown tool as a tool error.
    const hiddenWrapped = await executeToolCall(
      gatewayView([todoApp()], ADMIN, undefined, "compact"),
      {
        name: "everyapp_call_write",
        arguments: {
          name: "everyapp_provider_remove",
          arguments: { id: "stripe" },
        },
      },
      hosted.deps,
    );
    expect(hiddenWrapped).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [{ text: "Unknown tool: everyapp_provider_remove" }],
      },
    });
    expect(hosted.calls).toEqual([]);
  });
});
