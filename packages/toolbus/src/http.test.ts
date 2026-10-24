import { beforeAll, describe, expect, it } from "vitest";
import { listBuiltinTools } from "./builtins";
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
  audience: "every-acme-chef",
  name: "Chef",
  baseUrl: "https://chef-acme.example.com",
  instructions: undefined,
});

/** `<uuid>.<16 hex>`: the tool list hash is the last part. */
const SESSION_ID = /^[0-9a-f-]{36}\.[0-9a-f]{16}$/;

/** The todo app after a redeploy that added a tool. */
const todoAppWithArchive = () =>
  todoApp({
    tools: [
      ...todoApp().tools,
      {
        name: "archive_todo",
        description: "Archive a todo.",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  });

/** The JSON-RPC messages of an SSE body (comment frames skipped). */
function sseMessages(text: string): unknown[] {
  return text.split("\n\n").flatMap((frame) => {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    return data ? [JSON.parse(data)] : [];
  });
}

/**
 * Read SSE messages from a streaming response until `count` arrived (or the
 * stream ended); `raw` is everything read, comment frames included.
 */
async function readMessages(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<unknown[] & { raw: string; done: boolean }> {
  const decoder = new TextDecoder();
  let text = "";
  let raw = "";
  let ended = false;
  const messages: unknown[] = [];
  while (messages.length < count) {
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    raw += chunk;
    text += chunk;
    const frames = text.split("\n\n");
    text = frames.pop() ?? "";
    messages.push(...sseMessages(frames.join("\n\n") + "\n\n"));
  }
  return Object.assign(messages, { raw, done: ended });
}

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** A `subscriptions/listen` request and the id it carries. */
async function listenRequest(
  notifications: Record<string, unknown> = { toolsListChanged: true },
): Promise<{ request: Request; id: number }> {
  const request = modernRequest("subscriptions/listen", { notifications });
  const { id } = (await request.clone().json()) as { id: number };
  return { request, id };
}

/**
 * The built-ins carry Claude Code's always-load hint through the era codec
 * and app tools carry no `_meta` at all. `tools` is a tools/list result.
 */
function expectAlwaysLoadOnBuiltinsOnly(
  tools: { name: string; _meta?: unknown }[],
) {
  const builtins = listBuiltinTools().map((tool) => tool.name);
  expect(builtins.length).toBeGreaterThan(0);
  const listed = tools.filter((tool) => builtins.includes(tool.name));
  expect(listed.map((tool) => tool.name)).toEqual(builtins);
  for (const tool of listed) {
    expect(tool._meta, tool.name).toEqual({ "anthropic/alwaysLoad": true });
  }
  const appTools = tools.filter((tool) => !builtins.includes(tool.name));
  expect(appTools.length).toBeGreaterThan(0);
  for (const tool of appTools) {
    expect(tool, tool.name).not.toHaveProperty("_meta");
  }
}

function initializeRequest(version = "2025-11-25", headers = {}, url?: string) {
  return legacyRequest(
    "initialize",
    {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1" },
    },
    { version, headers, ...(url ? { url } : {}) },
  );
}

describe("2026-07-28 (modern) era", () => {
  it("holds subscriptions/listen and pushes tools/list_changed when the re-read view differs", async () => {
    const { serve } = toolBus({ listenPollMs: 10, listenMaxMs: 300 });
    let current = appView();
    const view: ToolBusView = { ...appView(), refresh: async () => current };

    // Only a view that can be re-read advertises the capability.
    const { result: plain } = await rpcBody(
      await serve(modernRequest("server/discover"), appView()),
    );
    expect(plain.capabilities).toEqual({ tools: { listChanged: false } });
    const { result: discovered } = await rpcBody(
      await serve(modernRequest("server/discover"), view),
    );
    expect(discovered.capabilities).toEqual({ tools: { listChanged: true } });

    const { request, id } = await listenRequest();
    const listen = await serve(request, view);
    expect(listen.status).toBe(200);
    expect(listen.headers.get("content-type")).toBe("text/event-stream");
    const reader = listen.body!.getReader();
    const [ack] = await readMessages(reader, 1);
    expect(ack).toEqual({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: {
        notifications: { toolsListChanged: true },
        _meta: { [SUBSCRIPTION_ID]: id },
      },
    });

    // The app is redeployed with another tool: the next poll pushes the
    // notification; the polls before it wrote keep-alives.
    await new Promise((resolve) => setTimeout(resolve, 35));
    current = appView(todoAppWithArchive());
    const changed = await readMessages(reader, 1);
    expect(changed[0]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
      params: { _meta: { [SUBSCRIPTION_ID]: id } },
    });
    expect(changed.raw).toContain(": keepalive\n\n");

    // Held until listenMaxMs, then ended with the request's result.
    const ended = await readMessages(reader, 1);
    expect(ended[0]).toEqual({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        _meta: {
          [SUBSCRIPTION_ID]: id,
          "io.modelcontextprotocol/serverInfo": {
            name: "every-app-todo",
            title: "Todos",
            version: "0.1.0",
          },
        },
      },
    });
    expect((await reader.read()).done).toBe(true);

    // Without refresh the SDK refuses the subscription, as before.
    const refused = await rpcBody(
      await serve((await listenRequest()).request, appView()),
    );
    expect(refused.error.code).toBe(-32603);
  });

  it("ends a listen stream gracefully when the view can't be re-read, or wasn't asked for", async () => {
    const { serve } = toolBus({ listenPollMs: 10, listenMaxMs: 5_000 });
    const gone: ToolBusView = {
      ...appView(),
      refresh: async () => {
        throw new Error("no catalog to serve");
      },
    };
    const { request, id } = await listenRequest();
    const reader = (await serve(request, gone)).body!.getReader();
    const messages = await readMessages(reader, 3);
    expect(messages.map((m) => (m as { method?: string }).method)).toEqual([
      "notifications/subscriptions/acknowledged",
      undefined,
    ]);
    expect(messages[1]).toMatchObject({
      id,
      result: { resultType: "complete" },
    });
    expect(messages.done).toBe(true);
    expect(messages.raw).not.toContain("list_changed");

    const other = await listenRequest({ resourcesListChanged: true });
    const unwanted = await readMessages(
      (
        await serve(other.request, {
          ...appView(),
          refresh: async () => appView(),
        })
      ).body!.getReader(),
      3,
    );
    expect(unwanted[0]).toMatchObject({ params: { notifications: {} } });
    expect(unwanted[1]).toMatchObject({
      id: other.id,
      result: { resultType: "complete" },
    });
    expect(unwanted.done).toBe(true);
  });

  it("stops re-reading the view once the client closes the stream, and caps the streams a credential holds", async () => {
    const { serve } = toolBus({ listenPollMs: 10, listenMaxMs: 5_000 });
    let reads = 0;
    const view: ToolBusView = {
      ...appView(),
      refresh: async () => {
        reads += 1;
        return appView();
      },
    };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await serve((await listenRequest()).request, view);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      readers.push(response.body!.getReader());
    }
    const ninth = await serve((await listenRequest()).request, view);
    expect(ninth.headers.get("content-type")).toContain("application/json");
    expect((await rpcBody(ninth)).error).toEqual({
      code: -32603,
      message: "Subscription limit reached",
    });
    // Another user's browser sessions have their own slots.
    const session = (userId: string): ToolBusView => ({
      ...view,
      principal: {
        ...PRINCIPAL,
        userId,
        credential: { kind: "session", id: "session" },
      },
    });
    const other = await serve(
      (await listenRequest()).request,
      session("user_2"),
    );
    expect(other.headers.get("content-type")).toBe("text/event-stream");
    await other.body!.cancel();

    await Promise.all(readers.map((reader) => reader.cancel()));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(reads).toBe(after);
    // Closed streams free their slot, and a burst of opens counts too.
    const burst = await Promise.all(
      Array.from({ length: 12 }, async () =>
        serve((await listenRequest()).request, view),
      ),
    );
    const streams = burst.filter(
      (response) =>
        response.headers.get("content-type") === "text/event-stream",
    );
    expect(streams).toHaveLength(8);
    await Promise.all(streams.map((response) => response.body!.cancel()));
  });

  it("leaves a listen request the classifier rejects to the SDK", async () => {
    const { serve } = toolBus();
    const view: ToolBusView = { ...appView(), refresh: async () => appView() };
    const { request } = await listenRequest();
    const headers = new Headers(request.headers);
    headers.delete("mcp-protocol-version");
    const unversioned = await serve(
      new Request(request.url, {
        method: "POST",
        headers,
        body: await request.text(),
      }),
      view,
    );
    expect(unversioned.status).toBe(400);
    expect((await rpcBody(unversioned)).error.code).toBe(-32020);

    const nameless = await serve(
      modernRequest(
        "subscriptions/listen",
        { notifications: { toolsListChanged: true } },
        { "mcp-method": "tools/list" },
      ),
      view,
    );
    expect(nameless.status).toBe(400);
    expect((await rpcBody(nameless)).error.code).toBe(-32020);

    const unfiltered = await rpcBody(
      await serve(modernRequest("subscriptions/listen"), view),
    );
    expect(unfiltered.error.code).toBe(-32602);
    const malformed = await rpcBody(
      await serve(
        (await listenRequest({ toolsListChanged: "yes" })).request,
        view,
      ),
    );
    expect(malformed.error.code).toBe(-32602);

    const jsonOnly = await serve((await listenRequest()).request, view);
    expect(jsonOnly.headers.get("content-type")).toBe("text/event-stream");
    await jsonOnly.body!.cancel();
    const noStream = await serve(
      modernRequest(
        "subscriptions/listen",
        { notifications: { toolsListChanged: true } },
        { accept: "application/json" },
      ),
      view,
    );
    expect(noStream.status).toBe(406);
  });

  it("answers a body that can't be read with a parse error, not a crash", async () => {
    const { serve } = toolBus();
    const broken = new Request("https://todo-acme.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
          controller.error(new Error("connection reset"));
        },
      }),
      // @ts-expect-error undici needs this for a stream body
      duplex: "half",
    });
    const response = await serve(broken, appView());
    expect(response.status).toBe(400);
    expect((await rpcBody(response)).error.code).toBe(-32700);
  });

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
      "everyapp_list_apps",
      "everyapp_whoami",
      "chef_create_todo",
      "chef_list_todos",
      "todo_create_todo",
      "todo_list_todos",
    ]);
    expect(result.tools[0].annotations).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("carries anthropic/alwaysLoad on the built-ins and on nothing else", async () => {
    const { serve } = toolBus();
    const { result } = await rpcBody(
      await serve(
        modernRequest("tools/list", {}, {}, "https://home.example.com/mcp"),
        gatewayView([todoApp(), chef]),
      ),
    );
    expectAlwaysLoadOnBuiltinsOnly(result.tools);
  });

  it("answers the built-in tools on the gateway without calling an app", async () => {
    const { serve, appCalls } = toolBus();
    const view = gatewayView([todoApp(), chef], {
      ...PRINCIPAL,
      organizationName: "Acme",
      credential: { kind: "oauth", id: "mcpc_1", clientName: "Claude" },
      access: "read",
    });
    const call = async (name: string) =>
      (
        await rpcBody(
          await serve(
            modernRequest(
              "tools/call",
              { name, arguments: {} },
              {},
              "https://home.example.com/mcp",
            ),
            view,
          ),
        )
      ).result;

    expect((await call("everyapp_whoami")).structuredContent).toEqual({
      user: { email: "user@example.com", role: "member" },
      organization: { id: "org_1", name: "Acme" },
      connection: { kind: "oauth", access: "read only", client: "Claude" },
      apps: ["todo", "chef"],
    });
    const listed = await call("everyapp_list_apps");
    expect(listed.structuredContent).toEqual({
      apps: [
        {
          id: "todo",
          name: "Todos",
          url: "https://todo-acme.example.com",
          tools: 1,
        },
        {
          id: "chef",
          name: "Chef",
          url: "https://chef-acme.example.com",
          tools: 1,
        },
      ],
    });
    expect(JSON.parse(listed.content[0].text)).toEqual(
      listed.structuredContent,
    );
    expect(appCalls).toEqual([]);

    // An app host has no built-ins.
    const onApp = await rpcBody(
      await serve(
        modernRequest("tools/call", {
          name: "everyapp_whoami",
          arguments: {},
        }),
        appView(),
      ),
    );
    expect(onApp.error.code).toBe(-32602);
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
      expect(init.headers.get("mcp-session-id")).toMatch(SESSION_ID);
      expect(init.headers.get("content-type")).toContain("application/json");
      const { result: initialized } = await rpcBody(init);
      expect(initialized).toMatchObject({
        protocolVersion: version,
        capabilities: { tools: { listChanged: true } },
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

  it("carries anthropic/alwaysLoad on the built-ins through the 2025-11-25 codec", async () => {
    const { serve } = toolBus();
    const view = gatewayView([todoApp(), chef]);
    const url = "https://home.example.com/mcp";
    const init = await serve(initializeRequest("2025-11-25", {}, url), view);
    expect(init.status).toBe(200);
    const list = await rpcBody(
      await serve(
        legacyRequest(
          "tools/list",
          {},
          {
            version: "2025-11-25",
            headers: { "mcp-session-id": init.headers.get("mcp-session-id")! },
            url,
          },
        ),
        view,
      ),
    );
    expectAlwaysLoadOnBuiltinsOnly(list.result.tools);
  });

  it("sends tools/list_changed before the result once the session's tool list changed", async () => {
    const { serve } = toolBus();
    const init = await serve(initializeRequest(), appView());
    const sessionId = init.headers.get("mcp-session-id")!;
    expect(sessionId).toMatch(SESSION_ID);

    // The app is redeployed with another tool. The next request on the
    // session streams the notification, then its own result.
    const after = appView(todoAppWithArchive());
    const call = await serve(
      legacyRequest(
        "tools/call",
        { name: "list_todos", arguments: {} },
        { headers: { "mcp-session-id": sessionId } },
      ),
      after,
    );
    expect(call.status).toBe(200);
    expect(call.headers.get("content-type")).toBe("text/event-stream");
    expect(sseMessages(await call.text())).toEqual([
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      {
        jsonrpc: "2.0",
        id: expect.any(Number),
        result: { content: [{ type: "text", text: "ran list_todos" }] },
      },
    ]);

    // A client that takes the session id from that response lists plainly;
    // one that keeps the old session is told to initialize again, and the
    // session it gets then names the current list.
    const rotated = call.headers.get("mcp-session-id")!;
    expect(rotated).toMatch(SESSION_ID);
    expect(rotated).not.toBe(sessionId);
    const listed = await serve(
      legacyRequest(
        "tools/list",
        {},
        { headers: { "mcp-session-id": rotated } },
      ),
      after,
    );
    expect(listed.headers.get("content-type")).toContain("application/json");
    expect(
      (await rpcBody(listed)).result.tools.map((t: { name: string }) => t.name),
    ).toEqual(["archive_todo", "create_todo", "list_todos"]);

    const stale = await serve(
      legacyRequest(
        "tools/list",
        {},
        { headers: { "mcp-session-id": sessionId } },
      ),
      after,
    );
    expect(stale.status).toBe(404);
    expect((await rpcBody(stale)).error.code).toBe(-32001);
    const again = await serve(
      initializeRequest("2025-11-25", { "mcp-session-id": sessionId }),
      after,
    );
    expect(again.headers.get("content-type")).toContain("application/json");
    expect(again.headers.get("mcp-session-id")!.split(".")[1]).toBe(
      rotated.split(".")[1],
    );
  });

  it("answers plain JSON while the session's tool list is unchanged", async () => {
    const { serve } = toolBus();
    const view = appView();
    const init = await serve(initializeRequest(), view);
    const sessionId = init.headers.get("mcp-session-id")!;

    const call = await serve(
      legacyRequest(
        "tools/call",
        { name: "list_todos", arguments: {} },
        { headers: { "mcp-session-id": sessionId } },
      ),
      view,
    );
    expect(call.status).toBe(200);
    expect(call.headers.get("content-type")).toContain("application/json");
    expect(call.headers.get("mcp-session-id")).toBeNull();
    expect((await rpcBody(call)).result.content).toEqual([
      { type: "text", text: "ran list_todos" },
    ]);

    // No session at all (a client from before sessions carried a hash):
    // nothing to compare, nothing streamed.
    const bare = await serve(
      legacyRequest("tools/call", { name: "list_todos", arguments: {} }),
      appView(todoAppWithArchive()),
    );
    expect(bare.headers.get("content-type")).toContain("application/json");
  });

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

  it("lets the gateway allow more browser origins, exactly", async () => {
    const { serve } = toolBus();
    const view = gatewayView([todoApp()], PRINCIPAL, ["http://localhost:6274"]);
    const list = (origin: string) =>
      serve(
        modernRequest(
          "tools/list",
          {},
          { origin },
          "https://home.example.com/mcp",
        ),
        view,
      );

    const inspector = await list("http://localhost:6274");
    expect(inspector.status).toBe(200);
    expect(inspector.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:6274",
    );
    for (const origin of [
      "http://localhost:6275",
      "https://localhost:6274",
      "https://evil.example",
    ]) {
      expect((await list(origin)).status, origin).toBe(403);
    }
    expect((await list("https://home.example.com")).status).toBe(200);
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

  it("refuses a chunked body over 256 KB before reading it whole", async () => {
    const { serve } = toolBus();
    const view: ToolBusView = { ...appView(), refresh: async () => appView() };
    const { request } = await listenRequest();
    const padded = new TextEncoder().encode(
      JSON.stringify({
        ...((await request.clone().json()) as object),
        pad: "x".repeat(4 * MAX_REQUEST_BODY_BYTES),
      }),
    );
    const chunkSize = 64 * 1024;
    const chunks = Math.ceil(padded.byteLength / chunkSize);
    let pulled = 0;
    const chunked = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: new ReadableStream({
        pull(controller) {
          if (pulled === chunks) {
            controller.close();
            return;
          }
          controller.enqueue(
            padded.subarray(pulled * chunkSize, (pulled + 1) * chunkSize),
          );
          pulled += 1;
        },
      }),
      // @ts-expect-error undici needs this for a stream body
      duplex: "half",
    });
    expect(chunked.headers.get("content-length")).toBeNull();
    const response = await serve(chunked, view);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(chunks);
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
