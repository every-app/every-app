/**
 * The workspace tools as the ToolBus lists and runs them: the definitions
 * hold to the rules the gateway's own schemas follow, the listing is by
 * role, access, mode and host, the search finds them in either mode, the
 * wrappers run them, a member or a read-only connection learns nothing,
 * and every call is audited like a built-in's. What each tool does is the
 * gateway's (workspace-tools.sqlite.test.ts there).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolCallResultV1 } from "@every-app/sdk/internal";
import { builtinToolKind, listBuiltinTools } from "./builtins";
import { createArgumentsDigester } from "./digest";
import { executeToolCall } from "./execute";
import { MAX_TOOL_NAME_LENGTH, splitNamespacedToolName } from "./names";
import { listTools } from "./server";
import {
  ISSUER,
  PRINCIPAL,
  appView,
  gatewayView,
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
const byRole = (role: string) =>
  WORKSPACE_TOOLS.filter((tool) => tool.minRole === role).map((tool) =>
    listed(tool.name),
  );
const MEMBER_TOOLS = byRole("member");
const ADMIN_TOOLS = byRole("admin");
const OWNER_TOOLS = byRole("owner");
const READ_TOOLS = WORKSPACE_TOOLS.filter((tool) => tool.risk === "read").map(
  (tool) => listed(tool.name),
);

/** A host that answers every tool with its name and arguments, or as told. */
function harness(
  answer: (
    name: string,
    args: JsonObject,
  ) => ToolCallResultV1 | Promise<ToolCallResultV1> = (name, args) => ({
    content: [{ type: "text", text: JSON.stringify({ name, args }) }],
    structuredContent: { name, args },
  }),
) {
  const calls: { name: string; args: JsonObject; principal: McpPrincipal }[] =
    [];
  const events: ToolCallAuditEvent[] = [];
  const invokeApp = vi.fn(async () => Response.json({}));
  const workspace: WorkspaceHost = {
    run: async (name, args, principal) => {
      calls.push({ name, args, principal });
      return answer(name, args);
    },
  };
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp,
    workspace,
    audit: (event) => events.push(event),
    digestArguments: createArgumentsDigester("secret", "test"),
  };
  return { deps, calls, events, invokeApp };
}

describe("the workspace tool definitions", () => {
  it("are the catalog the design names, each with a title, a description, a risk, a role and a closed schema", () => {
    const names = WORKSPACE_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      "workspace_show",
      "workspace_users",
      "workspace_invite",
      "workspace_uninvite",
      "workspace_role",
      "workspace_deactivate",
      "workspace_reactivate",
      "workspace_remove",
      "workspace_reset_email",
      "workspace_groups",
      "workspace_group_create",
      "workspace_group_set",
      "workspace_group_delete",
      "workspace_group_members",
      "workspace_group_members_set",
      "workspace_group_apps",
      "workspace_group_apps_set",
      "workspace_apps",
      "workspace_app_set",
      "workspace_app_access",
      "workspace_app_access_set",
      "workspace_app_cap",
      "workspace_app_delete",
      "workspace_usage",
      "workspace_activity",
      "workspace_rename",
      "my_tokens",
      "revoke_token",
      "my_connections",
      "revoke_connection",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of WORKSPACE_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.description.length, tool.name).toBeGreaterThan(20);
      expect(["read", "write"], tool.name).toContain(tool.risk);
      expect(["member", "admin", "owner"], tool.name).toContain(tool.minRole);
      expect(listed(tool.name).length, tool.name).toBeLessThanOrEqual(
        MAX_TOOL_NAME_LENGTH,
      );
      expect(splitNamespacedToolName(listed(tool.name))?.localName).toBe(
        tool.name,
      );
    }
  });

  it("keep every schema small: closed objects, every field described, no regex, reference or union", () => {
    const forbidden = [
      "pattern",
      "patternProperties",
      "$ref",
      "$dynamicRef",
      "$recursiveRef",
      "anyOf",
      "oneOf",
      "allOf",
      "not",
      "if",
      "uniqueItems",
    ];
    const walk = (node: unknown, where: string) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${where}[${index}]`));
        return;
      }
      if (!node || typeof node !== "object") return;
      const schema = node as Record<string, unknown>;
      for (const key of forbidden) {
        expect(schema, `${where} uses ${key}`).not.toHaveProperty(key);
      }
      if (schema["type"] === "object") {
        expect(schema["additionalProperties"], where).toBe(false);
        const properties = (schema["properties"] ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const [field, definition] of Object.entries(properties)) {
          expect(
            typeof definition["description"],
            `${where}.${field} has no description`,
          ).toBe("string");
          walk(definition, `${where}.${field}`);
        }
      }
      if (schema["items"]) walk(schema["items"], `${where}[]`);
    };
    for (const tool of WORKSPACE_TOOLS) {
      expect(tool.inputSchema["type"], tool.name).toBe("object");
      walk(tool.inputSchema, tool.name);
    }
  });

  it("make the two irreversible tools owner-only, asking confirm: true", () => {
    const irreversible = WORKSPACE_TOOLS.filter((tool) => tool.irreversible);
    expect(irreversible.map((tool) => tool.name)).toEqual([
      "workspace_remove",
      "workspace_app_delete",
    ]);
    for (const tool of irreversible) {
      expect(tool.minRole, tool.name).toBe("owner");
      expect(tool.risk, tool.name).toBe("write");
      expect(tool.inputSchema["required"], tool.name).toContain("confirm");
      expect(
        (tool.inputSchema["properties"] as Record<string, unknown>)["confirm"],
      ).toMatchObject({ type: "boolean", const: true });
    }
    expect(OWNER_TOOLS).toEqual(irreversible.map((tool) => listed(tool.name)));
  });

  it("split the member-level tools from the admin ones: the four on the caller's own account", () => {
    expect(MEMBER_TOOLS).toEqual([
      "everyapp_my_tokens",
      "everyapp_revoke_token",
      "everyapp_my_connections",
      "everyapp_revoke_connection",
    ]);
    expect(ADMIN_TOOLS.length + OWNER_TOOLS.length + MEMBER_TOOLS.length).toBe(
      WORKSPACE_TOOLS.length,
    );
  });
});

describe("listing the workspace tools", () => {
  const names = (
    principal: McpPrincipal,
    listing: "full" | "compact",
    workspace = true,
  ) =>
    listBuiltinTools({ principal, listing }, { workspace })
      .map((tool) => tool.name)
      .filter((name) => builtinToolKind(name) === "host");

  it("lists them in the full listing only, to the caller's role, writes only to a read & write caller, and only when the host runs them", () => {
    // The owner: every one, in definition order.
    expect(names(OWNER, "full")).toEqual(
      WORKSPACE_TOOLS.map((tool) => listed(tool.name)),
    );
    // An admin: every admin tool, never an owner-only one.
    expect(names(ADMIN, "full")).toEqual(
      WORKSPACE_TOOLS.filter((tool) => tool.minRole !== "owner").map((tool) =>
        listed(tool.name),
      ),
    );
    // A member: the four on their own account.
    expect(names(MEMBER, "full")).toEqual(MEMBER_TOOLS);
    // Read-only connections: the read tools of the role.
    expect(names(readOnly(ADMIN), "full")).toEqual(
      READ_TOOLS.filter((name) => !OWNER_TOOLS.includes(name)),
    );
    expect(names(readOnly(MEMBER), "full")).toEqual([
      "everyapp_my_tokens",
      "everyapp_my_connections",
    ]);
    // The compact listing leaves them out: the search finds them.
    expect(names(OWNER, "compact")).toEqual([]);
    // Without a host to run them, nothing is listed to anyone.
    expect(names(OWNER, "full", false)).toEqual([]);
    // And no view (the docs' drift test) lists all of them.
    expect(
      listBuiltinTools()
        .map((tool) => tool.name)
        .filter((name) => builtinToolKind(name) === "host"),
    ).toEqual(WORKSPACE_TOOLS.map((tool) => listed(tool.name)));
  });

  it("lists them after the core built-ins and before the apps' tools, deferred behind Claude Code's tool search", () => {
    const tools = listTools(gatewayView([todoApp()], ADMIN), {
      workspace: true,
    });
    const order = tools.map((tool) => tool.name);
    expect(order.slice(0, 3)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
    ]);
    expect(order[3]).toBe("everyapp_workspace_show");
    expect(order.at(-1)).toBe("todo_list_todos");
    const show = tools.find((tool) => tool.name === "everyapp_workspace_show")!;
    expect(show._meta).toBeUndefined();
    expect(show.annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    const remove = listTools(gatewayView([todoApp()], OWNER), {
      workspace: true,
    }).find((tool) => tool.name === "everyapp_workspace_remove")!;
    expect(remove.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    // Never on an app host, whatever the host supplies.
    expect(
      listTools(appView(todoApp(), OWNER), { workspace: true }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["create_todo", "list_todos"]);
  });
});

describe("running a workspace tool", () => {
  it("runs the host's handler as the caller, with checked arguments, and audits one row under everyapp", async () => {
    const { deps, calls, events, invokeApp } = harness();
    const view = gatewayView([todoApp()], ADMIN);
    const resolution = await executeToolCall(
      view,
      {
        name: "everyapp_workspace_invite",
        arguments: { email: "new@example.com" },
        protocolVersion: "2026-07-28",
      },
      deps,
    );
    expect(resolution).toMatchObject({
      kind: "result",
      result: {
        structuredContent: {
          name: "workspace_invite",
          args: { email: "new@example.com" },
        },
      },
      tool: expect.objectContaining({ name: "workspace_invite" }),
    });
    expect(calls).toEqual([
      {
        name: "workspace_invite",
        args: { email: "new@example.com" },
        principal: ADMIN,
      },
    ]);
    expect(invokeApp).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        surface: "gateway",
        tool: "everyapp_workspace_invite",
        appId: "everyapp",
        risk: "write",
        decision: "allowed",
        outcome: "ok",
        argsDigest: expect.stringMatching(/^[0-9a-f]{32}$/),
        resultBytes: expect.any(Number),
        protocolVersion: "2026-07-28",
        userId: "user_1",
        organizationId: "org_1",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("via");
    expect(events[0]).not.toHaveProperty("appRowId");
    expect(JSON.stringify(events)).not.toContain("new@example.com");
  });

  it("records a refusal the host answers as a tool error, and a host failure without its details", async () => {
    const refusing = harness(() => ({
      content: [{ type: "text", text: "USER_NOT_FOUND: User not found" }],
      isError: true,
    }));
    const view = gatewayView([todoApp()], ADMIN);
    const refused = await executeToolCall(
      view,
      { name: "everyapp_workspace_deactivate", arguments: { user: "x" } },
      refusing.deps,
    );
    expect(refused).toMatchObject({
      kind: "result",
      result: { isError: true },
    });
    expect(refusing.events[0]).toMatchObject({
      decision: "allowed",
      outcome: "tool_error",
    });

    const broken = harness(() => {
      throw new Error("D1_ERROR: the database is on fire at /secret/path");
    });
    const failed = await executeToolCall(
      view,
      { name: "everyapp_workspace_deactivate", arguments: { user: "x" } },
      broken.deps,
    );
    expect(failed).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          { type: "text", text: "everyapp_workspace_deactivate failed." },
        ],
      },
    });
    expect(JSON.stringify(failed)).not.toContain("on fire");
    expect(broken.events[0]).toMatchObject({
      decision: "allowed",
      outcome: "app_error",
      reason: "host_error",
    });
  });

  it("checks the arguments against the tool's own schema first, whatever their value count", async () => {
    const { deps, calls, events } = harness();
    const view = gatewayView([todoApp()], OWNER);
    const problem = async (name: string, args: unknown) => {
      const resolution = await executeToolCall(
        view,
        { name, arguments: args },
        deps,
      );
      if (resolution.kind !== "result") return resolution.kind;
      const [block] = resolution.result.content;
      return block?.type === "text" ? block["text"] : JSON.stringify(block);
    };
    // confirm must be true, not merely present.
    expect(
      await problem("everyapp_workspace_remove", {
        user: "a@example.com",
        confirm: false,
      }),
    ).toMatch(/^Invalid arguments for everyapp_workspace_remove: /);
    expect(
      await problem("everyapp_workspace_remove", { user: "a@example.com" }),
    ).toMatch(/^Invalid arguments for everyapp_workspace_remove: /);
    // Closed schemas: an unknown field is refused.
    expect(
      await problem("everyapp_workspace_users", { verbose: true }),
    ).toMatch(/^Invalid arguments for everyapp_workspace_users: /);
    // A padded call is checked all the same (the schema is the gateway's).
    expect(
      await problem("everyapp_workspace_group_create", {
        name: "",
        pad: new Array(2000).fill(0),
      }),
    ).toMatch(/^Invalid arguments for everyapp_workspace_group_create: /);
    expect(
      await problem("everyapp_workspace_app_cap", { app: "crm", cap: 0 }),
    ).toMatch(/^Invalid arguments for everyapp_workspace_app_cap: /);
    // And null is a cap.
    expect(
      await problem("everyapp_workspace_app_cap", { app: "crm", cap: null }),
    ).toContain('"cap":null');
    expect(calls).toHaveLength(1);
    expect(
      events.filter((event) => event.outcome === "invalid_arguments"),
    ).toHaveLength(5);
    for (const event of events) {
      expect(event).toMatchObject({ appId: "everyapp", decision: "allowed" });
    }
  });

  it("answers Unknown tool to a member, to a read-only connection for a write tool, to an admin for an owner tool, and without a host", async () => {
    const { deps, calls, events } = harness();
    const cases: [McpPrincipal, string, string][] = [
      [MEMBER, "everyapp_workspace_users", "role_required"],
      [readOnly(MEMBER), "everyapp_workspace_users", "role_required"],
      [ADMIN, "everyapp_workspace_remove", "role_required"],
      [readOnly(ADMIN), "everyapp_workspace_invite", "read_only_connection"],
      [readOnly(MEMBER), "everyapp_revoke_token", "read_only_connection"],
    ];
    for (const [principal, name, reason] of cases) {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], principal),
        { name, arguments: {} },
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
        outcome: "not_run",
      });
    }
    // The member's own tools run.
    const mine = await executeToolCall(
      gatewayView([todoApp()], MEMBER),
      { name: "everyapp_my_tokens", arguments: {} },
      deps,
    );
    expect(mine.kind).toBe("result");
    expect(calls).toEqual([{ name: "my_tokens", args: {}, principal: MEMBER }]);

    // No host: unknown to the owner too, and nothing listed.
    const { workspace: _workspace, ...hostless } = deps;
    const owner = gatewayView([todoApp()], OWNER);
    expect(
      await executeToolCall(
        owner,
        { name: "everyapp_workspace_show", arguments: {} },
        hostless,
      ),
    ).toEqual({ kind: "unknown_tool" });
    expect(events.at(-1)).toMatchObject({
      tool: "everyapp_workspace_show",
      decision: "blocked",
      reason: "unknown_tool",
    });
    expect(
      listTools(owner).filter((tool) => builtinToolKind(tool.name) === "host"),
    ).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("hides every one of them from a credential narrowed to apps, whatever its role: a token bound to one app, a connection consented to some", async () => {
    const { deps, calls, events } = harness();
    const narrowed: McpPrincipal[] = [
      {
        ...OWNER,
        credential: { kind: "pat", id: "pat_crm" },
        appScope: "selected",
      },
      {
        ...ADMIN,
        credential: { kind: "oauth", id: "mcpc_some", clientName: "Claude" },
        appScope: "selected",
      },
    ];
    for (const principal of narrowed) {
      const kind = principal.credential.kind;
      // Not listed, in either mode; the app's tools still are.
      const full = listTools(gatewayView([todoApp()], principal), {
        workspace: true,
      }).map((tool) => tool.name);
      expect(
        full.filter((name) => builtinToolKind(name) === "host"),
        kind,
      ).toEqual([]);
      expect(full, kind).toContain("todo_list_todos");
      expect(full, kind).toContain("todo_create_todo");
      // Not found by the search.
      const found = await executeToolCall(
        gatewayView([todoApp()], principal, undefined, "compact"),
        { name: "everyapp_search_tools", arguments: { app: "everyapp" } },
        deps,
      );
      expect(found, kind).toMatchObject({
        kind: "result",
        result: { structuredContent: { tools: [], total: 0 } },
      });
      // Unknown on call, directly and through a wrapper, the caller's own
      // member tools included; audited blocked with the reason.
      for (const name of [
        "everyapp_workspace_show",
        "everyapp_workspace_invite",
        "everyapp_my_tokens",
      ]) {
        expect(
          await executeToolCall(
            gatewayView([todoApp()], principal),
            { name, arguments: {} },
            deps,
          ),
          `${kind} ${name}`,
        ).toEqual({ kind: "unknown_tool" });
        expect(events.at(-1), `${kind} ${name}`).toMatchObject({
          tool: name,
          appId: "everyapp",
          decision: "blocked",
          reason: "app_scoped_credential",
          outcome: "not_run",
          credentialKind: kind,
        });
      }
      expect(
        await executeToolCall(
          gatewayView([todoApp()], principal, undefined, "compact"),
          {
            name: "everyapp_call_read",
            arguments: { name: "everyapp_workspace_users" },
          },
          deps,
        ),
        kind,
      ).toMatchObject({
        kind: "result",
        result: {
          isError: true,
          content: [
            { type: "text", text: "Unknown tool: everyapp_workspace_users" },
          ],
        },
      });
      expect(events.at(-1), kind).toMatchObject({
        tool: "everyapp_workspace_users",
        via: "everyapp_call_read",
        reason: "app_scoped_credential",
      });
    }
    expect(calls).toEqual([]);
  });

  it("is found by everyapp_search_tools in either mode, by the caller's role, and never by a member", async () => {
    const { deps } = harness();
    const search = async (
      principal: McpPrincipal,
      listing: "full" | "compact",
      query: JsonObject,
    ) => {
      const resolution = await executeToolCall(
        gatewayView([todoApp()], principal, undefined, listing),
        { name: "everyapp_search_tools", arguments: { limit: 25, ...query } },
        deps,
      );
      if (resolution.kind !== "result") throw new Error(resolution.kind);
      return resolution.result.structuredContent as {
        tools: { name: string; app: string; risk: string }[];
        total: number;
      };
    };
    for (const listing of ["full", "compact"] as const) {
      const { tools: found } = await search(ADMIN, listing, {
        query: "invite",
      });
      expect(
        found.map((tool) => tool.name),
        listing,
      ).toContain("everyapp_workspace_invite");
      expect(found[0], listing).toMatchObject({
        name: "everyapp_workspace_invite",
        app: "everyapp",
        risk: "write",
      });
      expect(found[0]).toHaveProperty("inputSchema");
    }
    // By app id, the gateway's own tools come as a list, by name, as many
    // as the search returns at once (25) out of the total.
    const own = await search(OWNER, "full", { app: "everyapp" });
    const everyName = WORKSPACE_TOOLS.map((tool) => listed(tool.name)).sort();
    expect(own.total).toBe(everyName.length);
    expect(own.tools.map((tool) => tool.name)).toEqual(
      everyName.slice(0, own.tools.length),
    );
    expect(own.tools.length).toBe(25);
    // A read-only admin finds the read tools alone.
    expect(
      (await search(readOnly(ADMIN), "compact", { app: "everyapp" })).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(READ_TOOLS.filter((name) => !OWNER_TOOLS.includes(name)).sort());
    // A member finds their own four, and nothing of the admin's.
    expect(
      (await search(MEMBER, "compact", { app: "everyapp" })).tools.map(
        (tool) => tool.name,
      ),
    ).toEqual([...MEMBER_TOOLS].sort());
    expect((await search(MEMBER, "full", { query: "invite" })).tools).toEqual(
      [],
    );
    // Without a host, the search knows none of them.
    const { workspace: _workspace, ...hostless } = deps;
    const none = await executeToolCall(
      gatewayView([todoApp()], OWNER),
      { name: "everyapp_search_tools", arguments: { app: "everyapp" } },
      hostless,
    );
    expect(none).toMatchObject({
      kind: "result",
      result: { structuredContent: { tools: [], total: 0 } },
    });
  });

  it("runs through the wrappers, audited once with via; the read wrapper runs the read ones only", async () => {
    const { deps, calls, events, invokeApp } = harness();
    const view = gatewayView([todoApp()], ADMIN, undefined, "compact");
    const read = await executeToolCall(
      view,
      {
        name: "everyapp_call_read",
        arguments: { name: "everyapp_workspace_users" },
      },
      deps,
    );
    expect(read).toMatchObject({
      kind: "result",
      result: { structuredContent: { name: "workspace_users", args: {} } },
      // What the client called.
      tool: expect.objectContaining({ name: "call_read" }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "everyapp_workspace_users",
      via: "everyapp_call_read",
      appId: "everyapp",
      risk: "read",
      decision: "allowed",
      outcome: "ok",
      argsDigest: expect.any(String),
    });

    const write = await executeToolCall(
      view,
      {
        name: "everyapp_call_write",
        arguments: {
          name: "everyapp_workspace_group_create",
          arguments: { name: "Sales" },
        },
      },
      deps,
    );
    expect(write).toMatchObject({
      kind: "result",
      result: {
        structuredContent: {
          name: "workspace_group_create",
          args: { name: "Sales" },
        },
      },
    });
    expect(events[1]).toMatchObject({
      tool: "everyapp_workspace_group_create",
      via: "everyapp_call_write",
      risk: "write",
      outcome: "ok",
    });
    // The same call made directly digests the same.
    await executeToolCall(
      view,
      {
        name: "everyapp_workspace_group_create",
        arguments: { name: "Sales" },
      },
      deps,
    );
    expect(events[2]!.argsDigest).toBe(events[1]!.argsDigest);
    expect(events[2]).not.toHaveProperty("via");

    // A write tool through the read wrapper: refused, saying where.
    const refused = await executeToolCall(
      view,
      {
        name: "everyapp_call_read",
        arguments: {
          name: "everyapp_workspace_group_create",
          arguments: { name: "Sales" },
        },
      },
      deps,
    );
    expect(refused).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "`everyapp_workspace_group_create` changes data; call it through everyapp_call_write.",
          },
        ],
      },
      tool: expect.objectContaining({ name: "call_read" }),
    });
    expect(events[3]).toMatchObject({
      tool: "everyapp_workspace_group_create",
      via: "everyapp_call_read",
      decision: "blocked",
      reason: "write_via_read_wrapper",
      outcome: "not_run",
    });
    // Through a wrapper, a hidden tool is the wrapper's tool error.
    const hidden = await executeToolCall(
      gatewayView([todoApp()], MEMBER, undefined, "compact"),
      {
        name: "everyapp_call_read",
        arguments: { name: "everyapp_workspace_users" },
      },
      deps,
    );
    expect(hidden).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          { type: "text", text: "Unknown tool: everyapp_workspace_users" },
        ],
      },
    });
    expect(events[4]).toMatchObject({
      tool: "everyapp_workspace_users",
      via: "everyapp_call_read",
      decision: "blocked",
      reason: "role_required",
    });
    // The wrapper's inner arguments are checked against the inner schema.
    const bad = await executeToolCall(
      view,
      {
        name: "everyapp_call_write",
        arguments: { name: "everyapp_workspace_invite", arguments: {} },
      },
      deps,
    );
    expect(bad).toMatchObject({
      kind: "result",
      result: { isError: true },
      tool: expect.objectContaining({ name: "call_write" }),
    });
    expect(
      (bad as { result: ToolCallResultV1 }).result.content[0],
    ).toMatchObject({
      text: expect.stringMatching(
        /^Invalid arguments for everyapp_workspace_invite: /,
      ),
    });
    expect(events[5]).toMatchObject({
      tool: "everyapp_workspace_invite",
      via: "everyapp_call_write",
      outcome: "invalid_arguments",
    });
    expect(calls.map((call) => call.name)).toEqual([
      "workspace_users",
      "workspace_group_create",
      "workspace_group_create",
    ]);
    expect(invokeApp).not.toHaveBeenCalled();
  });
});
