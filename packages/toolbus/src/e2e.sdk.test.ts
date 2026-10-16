/**
 * The ToolBus against a REAL app: `everyApp()` + `defineTools()` from the
 * SDK, reached through an in-process stand-in for the service binding. The
 * catalog is fetched with a real system token, calls carry real identity
 * tokens the SDK verifies, and the SDK's own checks (risk scopes, schemas,
 * error masking) run, so this covers the contract from both sides.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ToolError,
  defineTools,
  everyApp,
  type EveryAppUser,
} from "@every-app/sdk/server";
import { fetchAppCatalog } from "./catalog";
import { executeToolCall } from "./execute";
import { createToolBusHttp } from "./http";
import {
  ISSUER,
  PRINCIPAL,
  modernRequest,
  legacyRequest,
  rpcBody,
  testKeys,
} from "./test-fixtures";
import type { ToolBusApp, ToolBusDeps, ToolCallAuditEvent } from "./types";
import { appSurfaceView } from "./view";

type Todo = { id: string; title: string; completed: boolean };
const todos = new Map<string, Todo[]>();
const seenUsers: EveryAppUser[] = [];

const tools = defineTools(
  {
    list_todos: {
      description: "List the user's todos.",
      risk: "read",
      input: z.object({}).strict(),
      handler: (_input, { user }) => {
        seenUsers.push(user);
        return { todos: todos.get(user.id) ?? [] };
      },
    },
    create_todo: {
      description: "Create a todo.",
      risk: "write",
      input: z.object({ title: z.string().trim().min(1).max(255) }).strict(),
      handler: ({ title }, { user }) => {
        const todo = {
          id: `t${(todos.get(user.id)?.length ?? 0) + 1}`,
          title,
          completed: false,
        };
        todos.set(user.id, [...(todos.get(user.id) ?? []), todo]);
        return { todo };
      },
    },
    update_todo: {
      description: "Change a todo.",
      risk: "write",
      input: z
        .object({ id: z.string(), completed: z.boolean().optional() })
        .strict()
        .refine((input) => input.completed !== undefined, {
          message: "Provide a completed value",
        }),
      handler: ({ id }) => {
        throw new ToolError(`No todo with id ${id}`);
      },
    },
    find_todo: {
      description: "Find a todo by its title or its id.",
      risk: "read",
      input: z.discriminatedUnion("by", [
        z.object({ by: z.literal("title"), title: z.string() }).strict(),
        z.object({ by: z.literal("id"), id: z.string() }).strict(),
      ]),
      handler: (input, { user }) =>
        (todos.get(user.id) ?? []).find((todo) =>
          input.by === "id" ? todo.id === input.id : todo.title === input.title,
        ) ?? null,
    },
    delete_todo: {
      description: "Delete a todo forever.",
      risk: "destructive",
      input: z.object({ id: z.string() }).strict(),
      handler: () => "deleted",
    },
    explode: {
      description: "Always fails.",
      risk: "read",
      input: z.object({}).strict(),
      handler: () => {
        throw new Error("database password=hunter2 rejected");
      },
    },
  },
  { instructions: "Never guess todo ids." },
);

let keys: Awaited<ReturnType<typeof testKeys>>;
let app: ReturnType<typeof everyApp>;
let snapshotApp: ToolBusApp;
const ctx = { waitUntil: () => undefined };
// The Worker's name is the audience everyAppWorker() deploys it with.
const WORKER = "every-acme-todo";
const WORKER_ENV = { EVERYAPP_AUDIENCE: WORKER };

beforeAll(async () => {
  keys = await testKeys();
  app = everyApp(
    async () => new Response("app page"),
    { id: "todo" },
    { publicKeys: [keys.publicKeyPem], issuer: ISSUER, tools },
  );
  const snapshot = await fetchAppCatalog(
    {
      appId: "todo",
      audience: WORKER,
      baseUrl: "https://todo-acme.example.com",
    },
    {
      signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
      invoke: (request) => app.fetch(request, WORKER_ENV, ctx),
    },
  );
  if ("error" in snapshot) throw new Error(snapshot.error);
  snapshotApp = {
    rowId: "row_todo",
    appId: "todo",
    audience: WORKER,
    name: "Todos",
    baseUrl: "https://todo-acme.example.com",
    catalogHash: snapshot.hash,
    instructions: snapshot.instructions,
    tools: snapshot.tools,
  };
});

function harness(overrides: Partial<ToolBusDeps> = {}) {
  let invocations = 0;
  const events: ToolCallAuditEvent[] = [];
  const onCatalogDrift = vi.fn();
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: (_app, request) => {
      invocations += 1;
      return app.fetch(request, WORKER_ENV, ctx);
    },
    onCatalogDrift,
    audit: (event) => events.push(event),
    ...overrides,
  };
  return {
    deps,
    serve: createToolBusHttp(deps),
    events,
    onCatalogDrift,
    invocations: () => invocations,
  };
}

const view = () => appSurfaceView(snapshotApp, PRINCIPAL);

describe("ToolBus + real SDK app", () => {
  it("snapshots the app's catalog over the contract", () => {
    expect(snapshotApp.instructions).toBe("Never guess todo ids.");
    expect(snapshotApp.tools.map((tool) => [tool.name, tool.risk])).toEqual([
      ["create_todo", "write"],
      ["delete_todo", "destructive"],
      ["explode", "read"],
      ["find_todo", "read"],
      ["list_todos", "read"],
      ["update_todo", "write"],
    ]);
  });

  it("lists without calling the app and calls with exactly one invocation", async () => {
    const { serve, invocations } = harness();
    const list = await rpcBody(
      await serve(modernRequest("tools/list"), view()),
    );
    expect(
      list.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "create_todo",
      "explode",
      "find_todo",
      "list_todos",
      "update_todo",
    ]);
    expect(invocations()).toBe(0);

    const created = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "create_todo",
          arguments: { title: "  buy milk  " },
        }),
        view(),
      ),
    );
    expect(JSON.parse(created.result.content[0].text)).toEqual({
      todo: { id: "t1", title: "buy milk", completed: false },
    });
    expect(invocations()).toBe(1);
  });

  it("serves a tool whose input is a union of objects", async () => {
    const { serve, invocations } = harness();
    await serve(
      modernRequest("tools/call", {
        name: "create_todo",
        arguments: { title: "union milk" },
      }),
      view(),
    );
    const found = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "find_todo",
          arguments: { by: "title", title: "union milk" },
        }),
        view(),
      ),
    );
    expect(JSON.parse(found.result.content[0].text)).toMatchObject({
      title: "union milk",
    });

    const refused = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "find_todo",
          arguments: { by: "colour", colour: "red" },
        }),
        view(),
      ),
    );
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain(
      "Invalid arguments for find_todo",
    );
    // Refused by the gateway's own check: only the two good calls ran.
    expect(invocations()).toBe(2);
  });

  it("is refused by another Worker of the same app id", async () => {
    // The gateway mints for the Worker it reaches; another organization's
    // copy of `todo` rejects that identity and never runs the tool.
    seenUsers.length = 0;
    const { serve } = harness({
      invokeApp: (_app, request) =>
        app.fetch(request, { EVERYAPP_AUDIENCE: "every-beta-todo" }, ctx),
    });
    const refused = await rpcBody(
      await serve(
        modernRequest("tools/call", { name: "list_todos", arguments: {} }),
        view(),
      ),
    );
    expect(refused.result.isError).toBe(true);
    expect(seenUsers).toEqual([]);
  });

  it("delivers a verified chan:mcp identity bound to the call", async () => {
    seenUsers.length = 0;
    const { serve, events } = harness();
    await serve(
      legacyRequest("tools/call", { name: "list_todos", arguments: {} }),
      view(),
    );
    expect(seenUsers).toEqual([
      expect.objectContaining({
        id: "user_1",
        email: "user@example.com",
        orgId: "org_1",
        channel: "mcp",
        actor: { sub: "pat:pat_1" },
        scopes: ["mcp:read", "mcp:write"],
        toolCall: { id: events[0]!.callId, name: "list_todos" },
      }),
    ]);
    expect(events[0]).toMatchObject({ outcome: "ok", decision: "allowed" });
  });

  it("passes the app's own validation and ToolError messages through", async () => {
    const { serve, events } = harness();
    const refined = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "update_todo",
          arguments: { id: "t9" },
        }),
        view(),
      ),
    );
    expect(refined.result.isError).toBe(true);
    expect(refined.result.content[0].text).toContain(
      "Provide a completed value",
    );

    const missing = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "update_todo",
          arguments: { id: "t9", completed: true },
        }),
        view(),
      ),
    );
    expect(missing.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "No todo with id t9" }],
    });
    expect(events.map((event) => event.outcome)).toEqual([
      "invalid_arguments",
      "tool_error",
    ]);
  });

  it("masks unexpected errors behind a ref", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { serve, events } = harness();
    const response = await serve(
      modernRequest("tools/call", { name: "explode", arguments: {} }),
      view(),
    );
    const text = JSON.stringify(await rpcBody(response));
    expect(text).toContain(`Internal error in todo (ref ${events[0]!.callId})`);
    expect(text).not.toContain("hunter2");
    consoleError.mockRestore();
  });

  it("never calls destructive tools, and the SDK refuses them anyway", async () => {
    const { serve, deps, invocations } = harness();
    const hidden = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "delete_todo",
          arguments: { id: "t1" },
        }),
        view(),
      ),
    );
    expect(hidden.error.code).toBe(-32602);
    expect(invocations()).toBe(0);

    // Defense in depth: a snapshot that wrongly says "write" still can't
    // run it, because the SDK checks the scope for the risk it declared.
    const relabeled: ToolBusApp = {
      ...snapshotApp,
      tools: snapshotApp.tools.map((tool) =>
        tool.name === "delete_todo"
          ? { ...tool, risk: "write" as const }
          : tool,
      ),
    };
    const resolution = await executeToolCall(
      appSurfaceView(relabeled, PRINCIPAL),
      { name: "delete_todo", arguments: { id: "t1" } },
      deps,
    );
    expect(resolution).toMatchObject({
      kind: "result",
      result: { isError: true },
    });
    expect(invocations()).toBe(1);
  });

  it("re-syncs when the app's catalog changed since the snapshot", async () => {
    const { deps, onCatalogDrift } = harness();
    await executeToolCall(
      appSurfaceView(
        { ...snapshotApp, catalogHash: `sha256:${"0".repeat(64)}` },
        PRINCIPAL,
      ),
      { name: "list_todos", arguments: {} },
      deps,
    );
    expect(onCatalogDrift).toHaveBeenCalledOnce();

    const fresh = harness();
    await executeToolCall(
      view(),
      { name: "list_todos", arguments: {} },
      fresh.deps,
    );
    expect(fresh.onCatalogDrift).not.toHaveBeenCalled();
  });
});
