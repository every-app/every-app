import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  TOOLS_CALL_PATH,
} from "@every-app/sdk/internal";
import { SEARCH_RESULT_MAX_BYTES } from "./builtins";
import { createArgumentsDigester } from "./digest";
import { executeToolCall, MAX_RESULT_BYTES } from "./execute";
import { listTools } from "./server";
import {
  ISSUER,
  PRINCIPAL,
  appView,
  gatewayView,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type { ToolBusDeps, ToolBusView, ToolCallAuditEvent } from "./types";
import { MAX_CHECKED_VALUES, measureJson } from "./validation";

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

const OK_HASH = todoApp().catalogHash;

function ok(text = "done", catalogHash = OK_HASH) {
  return Response.json({
    v: 1,
    catalogHash,
    result: { content: [{ type: "text", text }] },
  });
}

function harness(answer: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const events: ToolCallAuditEvent[] = [];
  const drifted = vi.fn();
  const deps: ToolBusDeps = {
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async (_app, request) => {
      requests.push(request);
      return answer(request);
    },
    onCatalogDrift: drifted,
    audit: (event) => events.push(event),
    digestArguments: async () => "d".repeat(32),
  };
  return { deps, requests, events, drifted };
}

describe("executeToolCall", () => {
  it("calls the app once with an identity minted for exactly this call", async () => {
    const { deps, requests, events, drifted } = harness(() => ok("created"));

    const resolution = await executeToolCall(
      appView(),
      {
        name: "create_todo",
        arguments: { title: "milk" },
        protocolVersion: "2026-07-28",
      },
      deps,
    );

    expect(resolution).toMatchObject({
      kind: "result",
      result: { content: [{ type: "text", text: "created" }] },
    });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe(`https://todo-acme.example.com${TOOLS_CALL_PATH}`);
    const body = (await request.json()) as Record<string, unknown>;
    expect(body).toEqual({
      v: 1,
      name: "create_todo",
      arguments: { title: "milk" },
      callId: expect.any(String),
    });
    const claims = decodeJwt(request.headers.get(IDENTITY_HEADER)!);
    expect(claims).toMatchObject({
      typ: "user",
      sub: "user_1",
      aud: "every-acme-todo",
      iss: ISSUER,
      chan: "mcp",
      act: { sub: "pat:pat_1" },
      scopes: ["mcp:read", "mcp:write"],
      tc: { id: body["callId"], name: "create_todo" },
    });
    expect(drifted).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        surface: "app",
        tool: "create_todo",
        appId: "todo",
        appRowId: "row_todo",
        risk: "write",
        decision: "allowed",
        outcome: "ok",
        argsDigest: "d".repeat(32),
        protocolVersion: "2026-07-28",
        requestId: "ray_1",
        callId: body["callId"],
        credentialKind: "pat",
        credentialId: "pat_1",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("milk");
  });

  it("acts as the OAuth connection and names its client in the audit", async () => {
    const { deps, requests, events } = harness(() => ok());
    await executeToolCall(
      gatewayView([todoApp()], {
        ...PRINCIPAL,
        credential: { kind: "oauth", id: "mcpc_1", clientName: "Claude" },
      }),
      { name: "todo_create_todo", arguments: { title: "milk" } },
      deps,
    );
    const claims = decodeJwt(requests[0]!.headers.get(IDENTITY_HEADER)!);
    expect(claims["act"]).toEqual({ sub: "oauth:mcpc_1" });
    expect(claims["tc"]).toMatchObject({ name: "create_todo" });
    expect(events).toEqual([
      expect.objectContaining({
        surface: "gateway",
        tool: "todo_create_todo",
        appId: "todo",
        credentialKind: "oauth",
        credentialId: "mcpc_1",
        clientName: "Claude",
        outcome: "ok",
      }),
    ]);
  });

  it("audits the client the request names, on allowed and blocked calls alike", async () => {
    const { deps, events } = harness(() => ok());
    const clientInfo = "claude-code 1";
    await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {}, clientInfo },
      deps,
    );
    await executeToolCall(
      appView(),
      { name: "delete_todo", arguments: { id: "1" }, clientInfo },
      deps,
    );
    await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {} },
      deps,
    );
    expect(events.map((event) => [event.decision, event.clientInfo])).toEqual([
      ["allowed", "claude-code 1"],
      ["blocked", "claude-code 1"],
      ["allowed", undefined],
    ]);
  });

  it("lists an app that needs setup as unavailable, with why", async () => {
    const { deps } = harness(() => ok());
    const view: ToolBusView = {
      ...gatewayView([todoApp()]),
      unavailable: [
        {
          appId: "openseo",
          name: "OpenSEO",
          reason:
            "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY",
        },
      ],
    };

    const resolution = await executeToolCall(
      view,
      { name: "everyapp_list_apps", arguments: {} },
      deps,
    );
    expect(resolution).toMatchObject({
      kind: "result",
      result: {
        structuredContent: {
          apps: [
            { id: "todo", tools: 2 },
            {
              id: "openseo",
              name: "OpenSEO",
              available: false,
              reason:
                "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY",
            },
          ],
        },
      },
    });
    // Its tools aren't listed, and a call to one is an unknown tool.
    expect(listTools(view).map((tool) => tool.name)).not.toContain(
      "openseo_audit",
    );
  });

  it("audits the built-in tools, which never call an app", async () => {
    const { deps, requests, events } = harness(() => ok());
    const view = gatewayView([todoApp()], { ...PRINCIPAL, access: "read" });

    const resolution = await executeToolCall(
      view,
      { name: "everyapp_list_apps", arguments: {} },
      deps,
    );
    expect(resolution).toMatchObject({
      kind: "result",
      result: { structuredContent: { apps: [{ id: "todo", tools: 1 }] } },
    });
    await expect(
      executeToolCall(view, { name: "everyapp_nope", arguments: {} }, deps),
    ).resolves.toEqual({ kind: "unknown_tool" });
    expect(requests).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "everyapp_list_apps",
        appId: "everyapp",
        risk: "read",
        decision: "allowed",
        outcome: "ok",
        resultBytes: expect.any(Number),
      }),
      expect.objectContaining({
        tool: "everyapp_nope",
        decision: "blocked",
        reason: "unknown_tool",
      }),
    ]);
  });

  it("mints read-only scopes for read access and the dev kid when asked", async () => {
    const { deps, requests } = harness(() => ok());
    await executeToolCall(
      appView(todoApp(), { ...PRINCIPAL, access: "read" }),
      { name: "list_todos", arguments: {} },
      { ...deps, signing: { ...deps.signing, keyId: IDENTITY_DEV_KEY_ID } },
    );
    const token = requests[0]!.headers.get(IDENTITY_HEADER)!;
    expect(decodeJwt(token)["scopes"]).toEqual(["mcp:read"]);
    expect(decodeProtectedHeader(token).kid).toBe(IDENTITY_DEV_KEY_ID);
  });

  it("answers unknown and hidden tools without calling the app", async () => {
    const { deps, requests, events } = harness(() => ok());
    const readOnly = appView(todoApp(), { ...PRINCIPAL, access: "read" });

    for (const [view, name, reason] of [
      [appView(), "nope", "unknown_tool"],
      [appView(), "delete_todo", "destructive_requires_approval"],
      [readOnly, "create_todo", "read_only_connection"],
      [gatewayView([todoApp()]), "create_todo", "unknown_tool"],
    ] as const) {
      await expect(
        executeToolCall(view, { name, arguments: { id: "1" } }, deps),
      ).resolves.toEqual({ kind: "unknown_tool" });
      expect(events.at(-1)).toMatchObject({
        decision: "blocked",
        reason,
        outcome: "not_run",
      });
    }
    expect(requests).toHaveLength(0);
  });

  it("validates arguments against the snapshot before any app call", async () => {
    const { deps, requests, events } = harness(() => ok());
    for (const args of [{ title: "" }, { title: "x", extra: 1 }, [], "x"]) {
      const resolution = await executeToolCall(
        appView(),
        { name: "create_todo", arguments: args },
        deps,
      );
      expect(resolution).toMatchObject({
        kind: "result",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Invalid arguments for create_todo",
              ),
            },
          ],
        },
      });
    }
    expect(requests).toHaveLength(0);
    expect(events.every((e) => e.outcome === "invalid_arguments")).toBe(true);
  });

  it("never checks one registry row's calls with another row's schema", async () => {
    // One app id in two organizations (or a fork beside its original), both
    // reporting the same catalog hash: the hash is each app's own claim.
    const hash = `sha256:${"c".repeat(64)}`;
    const tagTool = (maxLength?: number) => ({
      name: "tag_todo",
      description: "Tag a todo.",
      risk: "write" as const,
      inputSchema: {
        type: "object",
        properties: {
          tag: { type: "string", ...(maxLength ? { maxLength } : {}) },
        },
        required: ["tag"],
      },
    });
    const loose = todoApp({
      rowId: "row_todo_other",
      catalogHash: hash,
      tools: [tagTool()],
    });
    const strict = todoApp({
      rowId: "row_todo_acme",
      catalogHash: hash,
      tools: [tagTool(3)],
    });
    const { deps, requests, events } = harness(() => ok());
    const call = { name: "tag_todo", arguments: { tag: "too long" } };

    await expect(
      executeToolCall(appView(loose), call, deps),
    ).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
    await expect(
      executeToolCall(appView(strict), call, deps),
    ).resolves.toMatchObject({ result: { isError: true } });
    expect(requests).toHaveLength(1);
    expect(events.map((event) => event.outcome)).toEqual([
      "ok",
      "invalid_arguments",
    ]);
  });

  it("never runs an app's regex on the gateway: a catastrophic pattern answers at once", async () => {
    const { deps, requests } = harness(() => ok());
    const app = todoApp({
      catalogHash: `sha256:${"e".repeat(64)}`,
      tools: [
        {
          name: "tag_todo",
          description: "Tag a todo.",
          risk: "write",
          inputSchema: {
            type: "object",
            properties: { tag: { type: "string", pattern: "^(a+)+$" } },
            required: ["tag"],
          },
        },
      ],
    });
    const startedAt = performance.now();
    const resolution = await executeToolCall(
      appView(app),
      { name: "tag_todo", arguments: { tag: `${"a".repeat(40)}!` } },
      deps,
    );
    expect(performance.now() - startedAt).toBeLessThan(50);
    // The pattern is the app's to check (the SDK validates every call).
    expect(resolution).toMatchObject({
      kind: "result",
      result: { content: [{ text: "done" }] },
    });
    expect(requests).toHaveLength(1);
  });

  it("leaves recursive schemas and large arguments to the app's own check", async () => {
    const { deps, requests } = harness(() => ok());
    const node = {
      anyOf: [
        { type: "object", properties: { c: { $ref: "#/$defs/node" } } },
        { type: "object", properties: { c: { $ref: "#/$defs/node" } } },
      ],
    };
    const app = todoApp({
      catalogHash: `sha256:${"f".repeat(64)}`,
      tools: [
        {
          name: "nest",
          description: "Nest.",
          risk: "read",
          inputSchema: {
            type: "object",
            $defs: { node },
            properties: { tree: { $ref: "#/$defs/node" } },
          },
        },
        {
          name: "dedupe",
          description: "Dedupe.",
          risk: "read",
          inputSchema: {
            type: "object",
            properties: { ids: { type: "array", uniqueItems: true } },
          },
        },
      ],
    });
    let tree: unknown = {};
    for (let i = 0; i < 40; i += 1) tree = { c: tree };
    const ids = Array.from({ length: 50_000 }, (_, i) => i);

    const startedAt = performance.now();
    for (const [name, args] of [
      ["nest", { tree }],
      ["dedupe", { ids }],
    ] as const) {
      await expect(
        executeToolCall(appView(app), { name, arguments: args }, deps),
      ).resolves.toMatchObject({
        kind: "result",
        result: { content: [{ text: "done" }] },
      });
    }
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(requests).toHaveLength(2);
  });

  it("refuses arguments too deep to walk, and still audits them", async () => {
    const { deps, requests, events } = harness(() => ok());
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];

    const resolution = await executeToolCall(
      appView(),
      { name: "create_todo", arguments: { title: "x", deep } },
      deps,
    );
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("more than 64 levels") }],
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        tool: "create_todo",
        decision: "allowed",
        outcome: "invalid_arguments",
        reason: "too_deep",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("argsDigest");
    expect(requests).toHaveLength(0);
  });

  it("audits a call whose check breaks, without the details", async () => {
    const { deps, requests, events } = harness(() => ok());
    const resolution = await executeToolCall(
      appView(),
      { name: "create_todo", arguments: { title: "x" } },
      {
        ...deps,
        digestArguments: async () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
      },
    );
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: "Invalid arguments for create_todo: they could not be checked.",
          },
        ],
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        outcome: "invalid_arguments",
        reason: "check_failed",
      }),
    ]);
    expect(requests).toHaveLength(0);
  });

  it("logs a client's over-long tool name cut to the spec's 128 characters", async () => {
    const { deps, events } = harness(() => ok());
    await expect(
      executeToolCall(
        appView(),
        { name: `list_todos${"x".repeat(200_000)}`, arguments: {} },
        deps,
      ),
    ).resolves.toEqual({ kind: "unknown_tool" });
    expect(events[0]).toMatchObject({
      decision: "blocked",
      reason: "unknown_tool",
    });
    expect(events[0]!.tool).toHaveLength(129);
    expect(events[0]!.tool.endsWith("…")).toBe(true);
  });

  it("schedules a re-sync when the app reports another catalog", async () => {
    const { deps, drifted } = harness(() =>
      ok("done", `sha256:${"c".repeat(64)}`),
    );
    await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {} },
      deps,
    );
    expect(drifted).toHaveBeenCalledOnce();
    expect(drifted).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "todo" }),
    );
  });

  it("maps the app's answers and failures to tool results", async () => {
    const cases: [
      () => Response | Promise<Response>,
      string,
      ToolCallAuditEvent["outcome"],
      boolean,
    ][] = [
      [
        () =>
          Response.json({
            v: 1,
            catalogHash: OK_HASH,
            result: {
              content: [{ type: "text", text: "No todo" }],
              isError: true,
            },
          }),
        "No todo",
        "tool_error",
        false,
      ],
      [
        () =>
          Response.json(
            {
              v: 1,
              error: { code: "invalid_arguments", message: "Provide a title" },
            },
            { status: 400 },
          ),
        "Provide a title",
        "invalid_arguments",
        false,
      ],
      [
        () =>
          Response.json(
            { v: 1, error: { code: "unknown_tool", message: "Unknown tool" } },
            { status: 404 },
          ),
        "no longer available",
        "app_error",
        true,
      ],
      [
        () => new Response("<html>oops</html>", { status: 500 }),
        "Todos failed to run list_todos.",
        "app_error",
        false,
      ],
      [
        () =>
          Response.json({ v: 1, catalogHash: OK_HASH, result: { text: "no" } }),
        "Todos failed to run list_todos.",
        "app_error",
        false,
      ],
      [
        () =>
          new Response("x", {
            headers: { "content-length": String(MAX_RESULT_BYTES + 1) },
          }),
        "larger than 1 MB",
        "app_error",
        false,
      ],
      [
        () => {
          throw new Error("No service binding");
        },
        "Todos could not be reached.",
        "unreachable",
        false,
      ],
    ];
    for (const [answer, text, outcome, drift] of cases) {
      const { deps, events, drifted } = harness(answer);
      const resolution = await executeToolCall(
        appView(),
        { name: "list_todos", arguments: {} },
        deps,
      );
      expect(resolution).toMatchObject({
        kind: "result",
        result: {
          isError: true,
          content: [{ type: "text", text: expect.stringContaining(text) }],
        },
      });
      expect(events[0]?.outcome, text).toBe(outcome);
      expect(drifted.mock.calls.length, text).toBe(drift ? 1 : 0);
    }
  });

  it("stops waiting for a slow app", async () => {
    const { deps, events } = harness(() => new Promise<Response>(() => {}));
    const resolution = await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {} },
      { ...deps, callTimeoutMs: 20 },
    );
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("did not answer") }],
      },
    });
    expect(events[0]?.outcome).toBe("timeout");
  });

  it("keeps the deadline running while the answer's body streams in", async () => {
    let cancelled = false;
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            // Headers and a first chunk, then nothing.
            controller.enqueue(new TextEncoder().encode('{"v":1,'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    const { deps, events } = harness(stalled);
    const startedAt = Date.now();
    const resolution = await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {} },
      { ...deps, callTimeoutMs: 50 },
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("did not answer") }],
      },
    });
    expect(events[0]?.outcome).toBe("timeout");
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });

  it("keeps structured content and drops fields MCP doesn't define", async () => {
    const { deps } = harness(() =>
      Response.json({
        v: 1,
        catalogHash: OK_HASH,
        result: {
          content: [{ type: "text", text: "{}" }],
          structuredContent: { n: 1 },
          isError: false,
          extra: "dropped",
        },
      }),
    );
    const resolution = await executeToolCall(
      appView(),
      { name: "list_todos", arguments: {} },
      deps,
    );
    expect(resolution).toEqual({
      kind: "result",
      tool: expect.objectContaining({ name: "list_todos" }),
      result: {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { n: 1 },
      },
    });
  });
});

/** An app whose tools have titles and descriptions worth searching. */
const notesApp = () =>
  todoApp({
    appId: "notes",
    rowId: "row_notes",
    audience: "every-acme-notes",
    name: "Notes",
    baseUrl: "https://notes-acme.example.com",
    instructions: undefined,
    tools: [
      {
        name: "search_notes",
        title: "Search notes",
        description: "Find notes by words.",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
      },
      {
        name: "create_note",
        title: "Create note",
        description: "Add a note.",
        risk: "write",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
      {
        name: "list_tags",
        description: "List the tags notes carry.",
        risk: "read",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "purge_notes",
        title: "Purge notes",
        description: "Delete every note.",
        risk: "destructive",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  });

const READ_ONLY = { ...PRINCIPAL, access: "read" as const };

describe("everyapp_search_tools", () => {
  const search = async (
    args: unknown,
    view: ToolBusView = gatewayView([todoApp(), notesApp()]),
    deps = harness(() => ok()).deps,
  ) => {
    const resolution = await executeToolCall(
      view,
      { name: "everyapp_search_tools", arguments: args },
      deps,
    );
    if (resolution.kind !== "result") throw new Error("no result");
    return resolution.result;
  };
  const names = (result: { structuredContent?: Record<string, unknown> }) =>
    (result.structuredContent!["tools"] as { name: string }[]).map(
      (tool) => tool.name,
    );

  it("ranks by the name, then the title, then the description, and reports the total", async () => {
    // "notes" is in every notes_ name (+5); the title of search_notes (+3)
    // and the descriptions of search_notes and list_tags (+1) break the tie.
    const result = await search({ query: "notes" });
    expect(names(result)).toEqual([
      "notes_search_notes",
      "notes_list_tags",
      "notes_create_note",
    ]);
    expect(result.structuredContent).toMatchObject({ total: 3 });
    expect(result.structuredContent).not.toHaveProperty("truncated");
    expect(JSON.parse(String(result.content[0]!["text"]))).toEqual(
      result.structuredContent,
    );
    // The whole name, listed or local, wins outright; the words still count.
    expect(names(await search({ query: "notes_search_notes" }))[0]).toBe(
      "notes_search_notes",
    );
    expect(names(await search({ query: "search_notes" }))[0]).toBe(
      "notes_search_notes",
    );
    // Case doesn't matter; the description ("Create a todo.") is the point
    // that puts the todo tool first.
    expect(names(await search({ query: "Create" }))).toEqual([
      "todo_create_todo",
      "notes_create_note",
    ]);
    // A token is a substring: "note" is in every notes_ name, and the
    // title and description words rank the one it names first.
    expect(names(await search({ query: "Create note" }))).toEqual([
      "notes_create_note",
      "notes_search_notes",
      "todo_create_todo",
      "notes_list_tags",
    ]);
    // Ties go by app id, then local name.
    expect(names(await search({ query: "list" }))).toEqual([
      "notes_list_tags",
      "todo_list_todos",
    ]);
    // Each result is enough to call the tool with.
    const [first] = result.structuredContent!["tools"] as Record<
      string,
      unknown
    >[];
    expect(first).toEqual({
      name: "notes_search_notes",
      app: "notes",
      title: "Search notes",
      description: "Find notes by words.",
      risk: "read",
      inputSchema: notesApp().tools[0]!.inputSchema,
    });
  });

  it("takes an app id alone (its tools by name), a limit, and both filters together", async () => {
    const byApp = await search({ app: "notes" });
    expect(names(byApp)).toEqual([
      "notes_create_note",
      "notes_list_tags",
      "notes_search_notes",
    ]);
    expect(names(await search({ app: "notes", query: "tags" }))).toEqual([
      "notes_list_tags",
    ]);
    expect(names(await search({ app: "nope" }))).toEqual([]);
    const limited = await search({ query: "notes", limit: 1 });
    expect(names(limited)).toEqual(["notes_search_notes"]);
    expect(limited.structuredContent).toMatchObject({ total: 3 });
    // Nothing matches: an empty answer, not an error.
    const none = await search({ query: "zzz" });
    expect(none.isError).toBeUndefined();
    expect(none.structuredContent).toEqual({ tools: [], total: 0 });
  });

  it("searches the caller's policy-filtered view: destructive never, write not for read-only", async () => {
    const all = await search({ query: "notes" });
    expect(names(all)).not.toContain("notes_purge_notes");
    expect(names(await search({ query: "purge delete" }))).toEqual([]);
    const readOnly = gatewayView([todoApp(), notesApp()], READ_ONLY);
    expect(names(await search({ query: "notes" }, readOnly))).toEqual([
      "notes_search_notes",
      "notes_list_tags",
    ]);
    expect(names(await search({ app: "todo" }, readOnly))).toEqual([
      "todo_list_todos",
    ]);
    // The built-ins are not app tools and are never found.
    expect(names(await search({ query: "everyapp whoami apps" }))).toEqual([]);
  });

  it("refuses arguments it can't use, as a tool error audited with the digest", async () => {
    const { deps, events } = harness(() => ok());
    const view = gatewayView([todoApp()]);
    const texts: string[] = [];
    for (const args of [
      {},
      { limit: 0 },
      { query: "x", limit: 26 },
      { query: "" },
      { query: "x", extra: 1 },
      { query: 1 },
      [],
      "x",
    ]) {
      const result = await search(args, view, deps);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      texts.push(String(result.content[0]!["text"]));
    }
    expect(texts[0]).toBe(
      "Invalid arguments for everyapp_search_tools: give a query, an app id, or both.",
    );
    for (const text of texts) {
      expect(text).toContain("Invalid arguments for everyapp_search_tools: ");
    }
    expect(events).toHaveLength(8);
    for (const event of events) {
      expect(event).toMatchObject({
        tool: "everyapp_search_tools",
        appId: "everyapp",
        risk: "read",
        decision: "allowed",
        outcome: "invalid_arguments",
      });
    }
    // The digest is there whenever the arguments were an object to digest.
    expect(events.slice(0, 6).every((event) => event.argsDigest)).toBe(true);
    expect(events[6]).not.toHaveProperty("argsDigest");
    expect(events[7]).not.toHaveProperty("argsDigest");
  });

  it("holds its bounds however many values the arguments carry", async () => {
    // An app's schema is skipped past MAX_CHECKED_VALUES (the app checks
    // again); a built-in's is the gateway's own and nobody checks after it,
    // so padding the arguments past the gate buys nothing: the same call
    // is refused with and without the padding.
    const { deps, requests, events } = harness(() => ok());
    const view = gatewayView([todoApp()]);
    const pad = new Array(MAX_CHECKED_VALUES).fill(0);
    expect(measureJson({ pad }, 64)).toMatchObject({
      values: MAX_CHECKED_VALUES + 2,
    });
    const padded = await search(
      { query: "x".repeat(201), limit: 26, extra: 1, pad },
      view,
      deps,
    );
    expect(padded.isError).toBe(true);
    expect(String(padded.content[0]!["text"])).toContain(
      "Invalid arguments for everyapp_search_tools: ",
    );
    const limitless = await search(
      { query: "todo", limit: 1e9, pad },
      view,
      deps,
    );
    expect(limitless.isError).toBe(true);
    // The wrappers too: a padded wrapper call with a field the schema
    // doesn't know never reaches the inner tool.
    const wrapped = await executeToolCall(
      view,
      {
        name: "everyapp_call_read",
        arguments: { name: "todo_list_todos", arguments: {}, pad },
      },
      deps,
    );
    expect(wrapped).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          {
            text: expect.stringContaining(
              "Invalid arguments for everyapp_call_read: ",
            ),
          },
        ],
      },
    });
    expect(requests).toEqual([]);
    expect(events.map((event) => [event.tool, event.outcome])).toEqual([
      ["everyapp_search_tools", "invalid_arguments"],
      ["everyapp_search_tools", "invalid_arguments"],
      ["everyapp_call_read", "invalid_arguments"],
    ]);
  });

  it("audits one row with the arguments' digest and the result's bytes, and never calls an app", async () => {
    const { deps, requests, events } = harness(() => ok());
    const result = await search(
      { query: "todo", limit: 5 },
      gatewayView([todoApp()]),
      deps,
    );
    expect(requests).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "everyapp_search_tools",
        appId: "everyapp",
        risk: "read",
        decision: "allowed",
        outcome: "ok",
        argsDigest: "d".repeat(32),
        resultBytes: new TextEncoder().encode(JSON.stringify(result)).length,
      }),
    ]);
    expect(events[0]).not.toHaveProperty("via");
  });

  it("stops adding tools once the answer would pass 256 KiB, and says so", async () => {
    // 25 tools whose schemas are near the catalog's 20 KiB each.
    const heavy = todoApp({
      appId: "heavy",
      rowId: "row_heavy",
      instructions: undefined,
      tools: Array.from({ length: 25 }, (_, index) => ({
        name: `read_${String(index).padStart(2, "0")}`,
        description: "Read.",
        risk: "read" as const,
        inputSchema: {
          type: "object",
          properties: {},
          description: "x".repeat(19 * 1024),
        },
      })),
    });
    const result = await search(
      { app: "heavy", limit: 25 },
      gatewayView([heavy]),
    );
    const found = result.structuredContent!["tools"] as unknown[];
    expect(found.length).toBeGreaterThan(0);
    expect(found.length).toBeLessThan(25);
    expect(result.structuredContent).toMatchObject({
      total: 25,
      truncated: true,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(bytes).toBeLessThanOrEqual(SEARCH_RESULT_MAX_BYTES);
    // One more tool would not have fit.
    const more = await search(
      { app: "heavy", limit: found.length + 1 },
      gatewayView([heavy]),
    );
    expect((more.structuredContent!["tools"] as unknown[]).length).toBe(
      found.length,
    );
  });
});

describe("the built-ins' arguments", () => {
  it("are checked against their own schema and digested on every row", async () => {
    const { deps, events } = harness(() => ok());
    const view = gatewayView([todoApp()]);
    const refused = await executeToolCall(
      view,
      { name: "everyapp_list_apps", arguments: { extra: 1 } },
      deps,
    );
    expect(refused).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          {
            text: expect.stringContaining(
              "Invalid arguments for everyapp_list_apps: ",
            ),
          },
        ],
      },
    });
    await executeToolCall(
      view,
      { name: "everyapp_whoami", arguments: undefined },
      deps,
    );
    expect(events).toEqual([
      expect.objectContaining({
        tool: "everyapp_list_apps",
        appId: "everyapp",
        outcome: "invalid_arguments",
        argsDigest: "d".repeat(32),
      }),
      expect.objectContaining({
        tool: "everyapp_whoami",
        appId: "everyapp",
        outcome: "ok",
        argsDigest: "d".repeat(32),
        resultBytes: expect.any(Number),
      }),
    ]);
  });

  it("are refused when too deep to walk, like any tool's", async () => {
    const { deps, events } = harness(() => ok());
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const resolution = await executeToolCall(
      gatewayView([todoApp()]),
      { name: "everyapp_search_tools", arguments: { query: "x", deep } },
      deps,
    );
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [{ text: expect.stringContaining("more than 64 levels") }],
      },
    });
    expect(events).toEqual([
      expect.objectContaining({
        tool: "everyapp_search_tools",
        outcome: "invalid_arguments",
        reason: "too_deep",
      }),
    ]);
  });
});

describe("the call wrappers", () => {
  const digestArguments = createArgumentsDigester("secret", "test");

  it("delegate one app call, audited once as the inner tool via the wrapper, with the direct call's digest", async () => {
    const { deps, requests, events } = harness(() => ok("listed"));
    const withDigest = { ...deps, digestArguments };
    const view = gatewayView([todoApp()]);

    const wrapped = await executeToolCall(
      view,
      {
        name: "everyapp_call_read",
        arguments: { name: "todo_list_todos", arguments: {} },
      },
      withDigest,
    );
    expect(wrapped).toMatchObject({
      kind: "result",
      result: { content: [{ type: "text", text: "listed" }] },
      // What the client called.
      tool: expect.objectContaining({ name: "call_read" }),
    });
    expect(requests).toHaveLength(1);
    const body = (await requests[0]!.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "list_todos", arguments: {} });
    const claims = decodeJwt(requests[0]!.headers.get(IDENTITY_HEADER)!);
    expect(claims).toMatchObject({
      chan: "mcp",
      aud: "every-acme-todo",
      scopes: ["mcp:read"],
      tc: { id: body["callId"], name: "list_todos" },
    });
    // Exactly one row: the inner tool's, with the wrapper as via.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: "gateway",
      tool: "todo_list_todos",
      via: "everyapp_call_read",
      appId: "todo",
      appRowId: "row_todo",
      risk: "read",
      decision: "allowed",
      outcome: "ok",
      callId: body["callId"],
      resultBytes: expect.any(Number),
    });

    // The same call made directly digests the same.
    await executeToolCall(
      view,
      { name: "todo_list_todos", arguments: {} },
      withDigest,
    );
    expect(events[1]).toMatchObject({
      tool: "todo_list_todos",
      argsDigest: events[0]!.argsDigest,
    });
    expect(events[1]).not.toHaveProperty("via");
    // Arguments left out of the wrapper call are the empty object too.
    await executeToolCall(
      view,
      { name: "everyapp_call_read", arguments: { name: "todo_list_todos" } },
      withDigest,
    );
    expect(events[2]!.argsDigest).toBe(events[0]!.argsDigest);
    expect(requests).toHaveLength(3);
  });

  it("mint read scopes only through the read wrapper, whatever the caller holds", async () => {
    const { deps, requests } = harness(() => ok());
    // A read & write caller: a direct call mints both, the read wrapper one.
    await executeToolCall(
      gatewayView([todoApp()]),
      { name: "everyapp_call_read", arguments: { name: "todo_list_todos" } },
      deps,
    );
    await executeToolCall(
      gatewayView([todoApp()]),
      { name: "todo_list_todos", arguments: {} },
      deps,
    );
    const scopes = requests.map(
      (request) => decodeJwt(request.headers.get(IDENTITY_HEADER)!)["scopes"],
    );
    expect(scopes).toEqual([["mcp:read"], ["mcp:read", "mcp:write"]]);
  });

  it("refuse a write tool through the read wrapper, saying where to call it, with one blocked row", async () => {
    const { deps, requests, events } = harness(() => ok());
    const resolution = await executeToolCall(
      gatewayView([todoApp()]),
      {
        name: "everyapp_call_read",
        arguments: { name: "todo_create_todo", arguments: { title: "milk" } },
      },
      deps,
    );
    expect(resolution).toMatchObject({
      kind: "result",
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "`todo_create_todo` changes data; call it through everyapp_call_write.",
          },
        ],
      },
    });
    expect(requests).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "todo_create_todo",
        via: "everyapp_call_read",
        appId: "todo",
        risk: "write",
        decision: "blocked",
        reason: "write_via_read_wrapper",
        outcome: "not_run",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("milk");
  });

  it("run write tools through the write wrapper with the caller's own scopes", async () => {
    const { deps, requests, events } = harness(() => ok("created"));
    const resolution = await executeToolCall(
      gatewayView([todoApp()]),
      {
        name: "everyapp_call_write",
        arguments: { name: "todo_create_todo", arguments: { title: "milk" } },
      },
      deps,
    );
    expect(resolution).toMatchObject({
      result: { content: [{ text: "created" }] },
    });
    expect(requests).toHaveLength(1);
    expect(await requests[0]!.json()).toMatchObject({
      name: "create_todo",
      arguments: { title: "milk" },
    });
    expect(
      decodeJwt(requests[0]!.headers.get(IDENTITY_HEADER)!)["scopes"],
    ).toEqual(["mcp:read", "mcp:write"]);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "todo_create_todo",
        via: "everyapp_call_write",
        risk: "write",
        decision: "allowed",
        outcome: "ok",
      }),
    ]);
  });

  it("hide the write wrapper from a read-only caller: unlisted, and Unknown tool when called", async () => {
    const { deps, requests, events } = harness(() => ok());
    const view = gatewayView([todoApp()], READ_ONLY, undefined, "compact");
    expect(listTools(view).map((tool) => tool.name)).not.toContain(
      "everyapp_call_write",
    );
    await expect(
      executeToolCall(
        view,
        {
          name: "everyapp_call_write",
          arguments: { name: "todo_list_todos" },
        },
        deps,
      ),
    ).resolves.toEqual({ kind: "unknown_tool" });
    expect(events).toEqual([
      expect.objectContaining({
        tool: "everyapp_call_write",
        appId: "everyapp",
        risk: "write",
        decision: "blocked",
        reason: "read_only_connection",
        outcome: "not_run",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("via");
    // The read wrapper serves them.
    await expect(
      executeToolCall(
        view,
        { name: "everyapp_call_read", arguments: { name: "todo_list_todos" } },
        deps,
      ),
    ).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
    expect(requests).toHaveLength(1);
  });

  it("answer unknown, hidden and built-in inner names as tool errors, one blocked row each", async () => {
    const { deps, requests, events } = harness(() => ok());
    const write = gatewayView([todoApp()]);
    const read = gatewayView([todoApp()], READ_ONLY);
    for (const [view, wrapper, name, reason] of [
      [write, "everyapp_call_read", "nope", "unknown_tool"],
      [write, "everyapp_call_write", "list_todos", "unknown_tool"],
      [write, "everyapp_call_write", "chef_list_todos", "unknown_tool"],
      [write, "everyapp_call_read", "everyapp_whoami", "unknown_tool"],
      [write, "everyapp_call_write", "everyapp_call_read", "unknown_tool"],
      [write, "everyapp_call_read", "everyapp_call_read", "unknown_tool"],
      [
        write,
        "everyapp_call_write",
        "todo_delete_todo",
        "destructive_requires_approval",
      ],
      [read, "everyapp_call_read", "todo_create_todo", "read_only_connection"],
    ] as const) {
      const resolution = await executeToolCall(
        view,
        { name: wrapper, arguments: { name, arguments: { id: "1" } } },
        deps,
      );
      expect(resolution, name).toMatchObject({
        kind: "result",
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        },
        tool: expect.objectContaining({
          name: wrapper.slice("everyapp_".length),
        }),
      });
      expect(events.at(-1), name).toMatchObject({
        tool: name,
        via: wrapper,
        decision: "blocked",
        reason,
        outcome: "not_run",
      });
    }
    expect(events).toHaveLength(8);
    expect(requests).toHaveLength(0);
  });

  it("refuse their own arguments as the wrapper's, one row each, without via", async () => {
    const { deps, requests, events } = harness(() => ok());
    const view = gatewayView([todoApp()]);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const cases: [string, unknown, string][] = [
      ["a string", "x", "arguments must be a JSON object."],
      ["an array", [], "arguments must be a JSON object."],
      ["no name", {}, 'required property "name"'],
      ["a number name", { name: 1 }, '"name"'],
      ["an empty name", { name: "" }, '"name"'],
      [
        "array arguments",
        { name: "todo_list_todos", arguments: [] },
        '"arguments"',
      ],
      [
        "string arguments",
        { name: "todo_list_todos", arguments: "x" },
        '"arguments"',
      ],
      ["an extra field", { name: "todo_list_todos", extra: 1 }, '"extra"'],
      [
        "deep arguments",
        { name: "todo_list_todos", arguments: { deep } },
        "more than 64 levels",
      ],
    ];
    for (const [label, args, problem] of cases) {
      const resolution = await executeToolCall(
        view,
        { name: "everyapp_call_read", arguments: args },
        deps,
      );
      if (resolution.kind !== "result") throw new Error(`${label}: no result`);
      expect(resolution.result.isError, label).toBe(true);
      const text = String(resolution.result.content[0]!["text"]);
      expect(text, label).toContain(
        "Invalid arguments for everyapp_call_read: ",
      );
      expect(text, label).toContain(problem);
    }
    expect(events).toHaveLength(cases.length);
    for (const event of events) {
      expect(event).toMatchObject({
        tool: "everyapp_call_read",
        appId: "everyapp",
        risk: "read",
        decision: "allowed",
        outcome: "invalid_arguments",
      });
      expect(event).not.toHaveProperty("via");
    }
    expect(events.at(-1)).toMatchObject({ reason: "too_deep" });
    expect(requests).toHaveLength(0);
  });

  it("check the inner arguments against the inner tool's own schema", async () => {
    const { deps, requests, events } = harness(() => ok());
    const resolution = await executeToolCall(
      gatewayView([todoApp()]),
      {
        name: "everyapp_call_write",
        arguments: { name: "todo_create_todo", arguments: { title: "" } },
      },
      deps,
    );
    expect(resolution).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: expect.stringContaining(
              "Invalid arguments for todo_create_todo: ",
            ),
          },
        ],
      },
    });
    expect(requests).toHaveLength(0);
    expect(events).toEqual([
      expect.objectContaining({
        tool: "todo_create_todo",
        via: "everyapp_call_write",
        decision: "allowed",
        outcome: "invalid_arguments",
        argsDigest: "d".repeat(32),
      }),
    ]);
  });

  it("are callable in full mode too, and never on an app host", async () => {
    const { deps, requests } = harness(() => ok());
    const full = gatewayView([todoApp()], PRINCIPAL, undefined, "full");
    expect(listTools(full).map((tool) => tool.name)).not.toContain(
      "everyapp_call_read",
    );
    await expect(
      executeToolCall(
        full,
        { name: "everyapp_call_read", arguments: { name: "todo_list_todos" } },
        deps,
      ),
    ).resolves.toMatchObject({ result: { content: [{ text: "done" }] } });
    expect(requests).toHaveLength(1);
    await expect(
      executeToolCall(
        appView(),
        { name: "everyapp_call_read", arguments: { name: "list_todos" } },
        deps,
      ),
    ).resolves.toEqual({ kind: "unknown_tool" });
    expect(requests).toHaveLength(1);
  });
});
