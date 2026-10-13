import { beforeAll, describe, expect, it } from "vitest";
import { createToolBusHttp, MAX_REQUEST_BODY_BYTES } from "./http";
import {
  ISSUER,
  PRINCIPAL,
  appView,
  gatewayView,
  legacyRequest,
  modernRequest,
  rpcBody,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type { ToolBusDeps, ToolBusView, ToolCallAuditEvent } from "./types";

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

/** A ToolBus over a scripted app that echoes the tool it was asked to run. */
function toolBus(overrides: Partial<ToolBusDeps> = {}) {
  const appCalls: string[] = [];
  const serve = createToolBusHttp({
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async (app, request) => {
      const body = (await request.json()) as { name: string };
      appCalls.push(`${app.appId}.${body.name}`);
      return Response.json({
        v: 1,
        catalogHash: app.catalogHash,
        result: { content: [{ type: "text", text: `ran ${body.name}` }] },
      });
    },
    ...overrides,
  });
  return { serve, appCalls };
}

const chef = todoApp({
  appId: "chef",
  rowId: "row_chef",
  name: "Chef",
  baseUrl: "https://chef-acme.example.com",
  instructions: undefined,
});

describe("2026-07-28 (modern) era", () => {
  it("answers server/discover with the tools capability and instructions", async () => {
    const { serve } = toolBus();
    const response = await serve(modernRequest("server/discover"), appView());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const { result } = await rpcBody(response);
    expect(result).toMatchObject({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: false } },
      instructions: "Call list_todos first.",
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "every-app-todo",
          title: "Todos",
        },
      },
    });
    expect(result.capabilities).not.toHaveProperty("resources");
    expect(result.capabilities).not.toHaveProperty("prompts");
  });

  it("lists visible tools under local names with cache hints and no app call", async () => {
    const { serve, appCalls } = toolBus();
    const { result } = await rpcBody(
      await serve(modernRequest("tools/list"), appView()),
    );

    expect(result.ttlMs).toBe(60_000);
    expect(result.cacheScope).toBe("private");
    expect(result.tools).toEqual([
      {
        name: "create_todo",
        title: "Create todo",
        description: "Create a todo.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string", minLength: 1 } },
          required: ["title"],
          additionalProperties: false,
        },
        annotations: {
          idempotentHint: false,
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      {
        name: "list_todos",
        description: "List todos.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
    ]);
    expect(appCalls).toEqual([]);
  });

  it("spells out every hint the spec would otherwise assume true", async () => {
    const { serve } = toolBus();
    const web = todoApp({
      tools: [
        {
          name: "fetch_page",
          description: "Fetch a web page.",
          risk: "read",
          inputSchema: { type: "object" },
          annotations: { openWorldHint: true },
        },
        {
          name: "post_message",
          description: "Post to a chat service.",
          risk: "write",
          inputSchema: { type: "object" },
          annotations: { openWorldHint: true, idempotentHint: false },
        },
      ],
    });
    const { result } = await rpcBody(
      await serve(modernRequest("tools/list"), appView(web)),
    );
    expect(
      result.tools.map((tool: { name: string; annotations: object }) => [
        tool.name,
        tool.annotations,
      ]),
    ).toEqual([
      ["fetch_page", { readOnlyHint: true, openWorldHint: true }],
      [
        "post_message",
        {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
          idempotentHint: false,
        },
      ],
    ]);
  });

  it("namespaces and orders tools across apps on the gateway surface", async () => {
    const { serve } = toolBus();
    const view = gatewayView([todoApp(), chef]);
    const { result } = await rpcBody(
      await serve(
        modernRequest("tools/list", {}, {}, "https://home.example.com/mcp"),
        view,
      ),
    );
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "chef_create_todo",
      "chef_list_todos",
      "todo_create_todo",
      "todo_list_todos",
    ]);
  });

  it("hides write tools from read-only callers", async () => {
    const { serve } = toolBus();
    const { result } = await rpcBody(
      await serve(
        modernRequest("tools/list"),
        appView(todoApp(), { ...PRINCIPAL, access: "read" }),
      ),
    );
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "list_todos",
    ]);
  });

  it("calls a tool with exactly one app invocation", async () => {
    const { serve, appCalls } = toolBus();
    const response = await serve(
      modernRequest("tools/call", {
        name: "create_todo",
        arguments: { title: "milk" },
      }),
      appView(),
    );
    const { result } = await rpcBody(response);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "ran create_todo" }],
      resultType: "complete",
    });
    expect(appCalls).toEqual(["todo.create_todo"]);
  });

  it("returns invalid arguments as a tool error the model can read", async () => {
    const { serve, appCalls } = toolBus();
    const { result } = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "create_todo",
          arguments: { title: "" },
        }),
        appView(),
      ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Invalid arguments for create_todo",
    );
    expect(result.content[0].text).toContain("too short");
    expect(appCalls).toEqual([]);
  });

  it("answers unknown and destructive tools with -32602 Unknown tool", async () => {
    const { serve, appCalls } = toolBus();
    for (const name of ["nope", "delete_todo"]) {
      const body = await rpcBody(
        await serve(
          modernRequest("tools/call", { name, arguments: { id: "1" } }),
          appView(),
        ),
      );
      expect(body.error).toEqual({
        code: -32602,
        message: `Unknown tool: ${name}`,
      });
    }
    expect(appCalls).toEqual([]);
  });

  it("rejects a Mcp-Name header that disagrees with the body", async () => {
    const { serve, appCalls } = toolBus();
    const response = await serve(
      modernRequest(
        "tools/call",
        { name: "create_todo", arguments: { title: "x" } },
        { "mcp-name": "list_todos" },
      ),
      appView(),
    );
    expect(response.status).toBe(400);
    expect((await rpcBody(response)).error.code).toBe(-32020);
    expect(appCalls).toEqual([]);
  });
});

describe("2025 (legacy) eras", () => {
  for (const version of ["2025-06-18", "2025-11-25"]) {
    it(`serves initialize, tools/list and tools/call statelessly at ${version}`, async () => {
      const { serve, appCalls } = toolBus();
      const view = appView();

      const init = await serve(
        legacyRequest("initialize", {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "claude-code", version: "1" },
        }),
        view,
      );
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBeNull();
      expect(init.headers.get("content-type")).toContain("application/json");
      const { result: initialized } = await rpcBody(init);
      expect(initialized).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "every-app-todo", title: "Todos" },
        instructions: "Call list_todos first.",
      });

      const ack = await serve(
        legacyRequest("notifications/initialized", undefined, {
          version,
          notification: true,
        }),
        view,
      );
      expect(ack.status).toBe(202);

      const list = await rpcBody(
        await serve(legacyRequest("tools/list", {}, { version }), view),
      );
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
        "create_todo",
        "list_todos",
      ]);
      expect(list.result).not.toHaveProperty("ttlMs");

      const call = await rpcBody(
        await serve(
          legacyRequest(
            "tools/call",
            { name: "list_todos", arguments: {} },
            { version },
          ),
          view,
        ),
      );
      expect(call.result.content).toEqual([
        { type: "text", text: "ran list_todos" },
      ]);

      const unknown = await rpcBody(
        await serve(
          legacyRequest(
            "tools/call",
            { name: "delete_todo", arguments: { id: "1" } },
            { version },
          ),
          view,
        ),
      );
      expect(unknown.error.code).toBe(-32602);
      expect(appCalls).toEqual(["todo.list_todos"]);
    });
  }

  it("refuses JSON-RPC batches, whatever their routing headers say", async () => {
    const { serve, appCalls } = toolBus();
    const call = (id: number, title: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "create_todo", arguments: { title } },
    });
    for (const [batch, headers] of [
      [
        [call(1, "a")],
        { "mcp-method": "tools/list", "mcp-name": "list_todos" },
      ],
      [Array.from({ length: 100 }, (_, i) => call(i + 1, `t${i}`)), {}],
      [
        [
          { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          { jsonrpc: "2.0", method: "notifications/initialized" },
        ],
        {},
      ],
    ] as const) {
      const response = await serve(
        new Request("https://todo-acme.example.com/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            ...headers,
          },
          body: JSON.stringify(batch),
        }),
        appView(),
      );
      expect(response.status).toBe(400);
      expect(await rpcBody(response)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message:
            "Bad Request: JSON-RPC batches are not supported by this endpoint.",
        },
      });
    }
    // A batch of 2026-07-28 messages is the modern leg's to refuse.
    const modern = (await modernRequest("tools/list").json()) as object;
    const modernBatch = await serve(
      new Request("https://todo-acme.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify([modern, modern]),
      }),
      appView(),
    );
    expect(modernBatch.status).toBe(400);
    expect((await rpcBody(modernBatch)).error.code).toBe(-32600);
    expect(appCalls).toEqual([]);
  });

  it("answers arguments too deep to check with a tool error and an audit line", async () => {
    const events: ToolCallAuditEvent[] = [];
    const { serve, appCalls } = toolBus({
      audit: (event) => events.push(event),
    });
    const depth = 60_000;
    const response = await serve(
      new Request("https://todo-acme.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"create_todo","arguments":{"title":"x","deep":${"[".repeat(depth)}${"]".repeat(depth)}}}}`,
      }),
      appView(),
    );
    expect(response.status).toBe(200);
    const { result } = await rpcBody(response);
    expect(result).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("more than 64 levels") }],
    });
    expect(events).toEqual([
      expect.objectContaining({
        outcome: "invalid_arguments",
        reason: "too_deep",
      }),
    ]);
    expect(appCalls).toEqual([]);
  });

  it("answers ping", async () => {
    const { serve } = toolBus();
    const body = await rpcBody(
      await serve(legacyRequest("ping", undefined), appView()),
    );
    expect(body.result).toEqual({});
  });

  it("rejects routing headers that disagree with the body", async () => {
    const { serve, appCalls } = toolBus();
    const mismatched: Record<string, string>[] = [
      { "mcp-name": "list_todos" },
      { "mcp-method": "tools/list" },
    ];
    for (const headers of mismatched) {
      const response = await serve(
        legacyRequest(
          "tools/call",
          { name: "create_todo", arguments: { title: "x" } },
          { headers },
        ),
        appView(),
      );
      expect(response.status).toBe(400);
      expect((await rpcBody(response)).error.code).toBe(-32020);
    }
    const matching = await serve(
      legacyRequest(
        "tools/call",
        { name: "list_todos", arguments: {} },
        { headers: { "mcp-name": "list_todos", "mcp-method": "tools/call" } },
      ),
      appView(),
    );
    expect(matching.status).toBe(200);
    expect(appCalls).toEqual(["todo.list_todos"]);
  });
});

describe("transport guards", () => {
  const view: ToolBusView = appView();

  it("lets a browser call only from the app's own origin", async () => {
    const { serve } = toolBus();
    const list = (origin?: string) =>
      serve(modernRequest("tools/list", {}, origin ? { origin } : {}), view);

    expect((await list()).status).toBe(200);
    const sameOrigin = await list("https://todo-acme.example.com");
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.headers.get("access-control-allow-origin")).toBeNull();

    for (const origin of [
      "https://evil.example",
      "https://sibling-acme.example.com",
      "null",
      "http://localhost:6274",
    ]) {
      const refused = await list(origin);
      expect(refused.status, origin).toBe(403);
      expect((await rpcBody(refused)).error.code).toBe(-32000);
    }
  });

  it("serves only localhost-class hosts and origins in local dev", async () => {
    const { serve } = toolBus({ localhostOnly: true });
    const devView = appView(todoApp({ baseUrl: "http://todo.localhost:8787" }));
    const request = (host: string, origin?: string) =>
      modernRequest(
        "tools/list",
        {},
        { host, ...(origin ? { origin } : {}) },
        `http://${host}/mcp`,
      );

    expect((await serve(request("todo.localhost:8787"), devView)).status).toBe(
      200,
    );
    expect(
      (
        await serve(
          request("todo.localhost:8787", "http://localhost:6274"),
          devView,
        )
      ).status,
    ).toBe(200);
    expect(
      (await serve(request("attacker.example:8787"), devView)).status,
    ).toBe(403);
    expect(
      (
        await serve(
          request("todo.localhost:8787", "https://evil.example"),
          devView,
        )
      ).status,
    ).toBe(403);
  });

  it("answers GET and DELETE with 405", async () => {
    const { serve } = toolBus();
    for (const method of ["GET", "DELETE"]) {
      const response = await serve(
        new Request("https://todo-acme.example.com/mcp", { method }),
        view,
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST, OPTIONS");
    }
  });

  // A preflight only reaches the ToolBus in `everyapp dev`: on an app host
  // the perimeter authenticates first, and a preflight carries no
  // credentials (the gateway and CLI tests cover both paths end to end).
  it("answers a localhost preflight in local dev, without credentials", async () => {
    const { serve } = toolBus({ localhostOnly: true });
    const devView = appView(todoApp({ baseUrl: "http://todo.localhost:8787" }));
    const preflight = (origin: string) =>
      serve(
        new Request("http://todo.localhost:8787/mcp", {
          method: "OPTIONS",
          headers: {
            host: "todo.localhost:8787",
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers":
              "authorization, content-type, mcp-protocol-version",
          },
        }),
        devView,
      );

    const inspector = await preflight("http://localhost:6274");
    expect(inspector.status).toBe(204);
    expect(inspector.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:6274",
    );
    expect(inspector.headers.get("access-control-allow-methods")).toBe(
      "POST, OPTIONS",
    );
    expect(inspector.headers.get("access-control-allow-headers")).toContain(
      "mcp-protocol-version",
    );
    expect(
      inspector.headers.get("access-control-allow-credentials"),
    ).toBeNull();
    expect((await preflight("https://evil.example")).status).toBe(403);
  });

  it("refuses bodies over 256 KB", async () => {
    const { serve } = toolBus();
    const big = modernRequest("tools/call", {
      name: "create_todo",
      arguments: { title: "x".repeat(MAX_REQUEST_BODY_BYTES) },
    });
    expect((await serve(big, view)).status).toBe(413);

    const declared = new Request("https://todo-acme.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_REQUEST_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect((await serve(declared, view)).status).toBe(413);
  });
});
