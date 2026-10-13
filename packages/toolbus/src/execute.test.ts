import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  IDENTITY_DEV_KEY_ID,
  IDENTITY_HEADER,
  TOOLS_CALL_PATH,
} from "@every-app/sdk/internal";
import { executeToolCall, MAX_RESULT_BYTES } from "./execute";
import {
  ISSUER,
  PRINCIPAL,
  appView,
  gatewayView,
  testKeys,
  todoApp,
} from "./test-fixtures";
import type { ToolBusDeps, ToolCallAuditEvent } from "./types";

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
      aud: "todo",
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
