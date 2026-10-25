import { beforeAll, describe, expect, it } from "vitest";
import { createToolBusHttp } from "../http";
import { ISSUER, gatewayView, testKeys, todoApp } from "../test-fixtures";
import { MAX_LIST_PAGES, RemoteMcpClient, RemoteMcpError } from "./client";

const URL_ = "https://treg.example/mcp";
const TOKEN = "s3cret-token-value-0123";
const AUTH = { authorization: `Bearer ${TOKEN}` };

let keys: Awaited<ReturnType<typeof testKeys>>;
beforeAll(async () => {
  keys = await testKeys();
});

/** The real ToolBus as a remote server: it speaks both eras. */
function toolBusUpstream(record: Request[] = []) {
  const serve = createToolBusHttp({
    signing: { privateKeyPem: keys.privateKeyPem, issuer: ISSUER },
    invokeApp: async (_app, request) => {
      const body = (await request.json()) as {
        name: string;
        arguments: unknown;
      };
      return Response.json({
        v: 1,
        catalogHash: todoApp().catalogHash,
        result: {
          content: [
            {
              type: "text",
              text: `ran ${body.name} with ${JSON.stringify(body.arguments)}`,
            },
          ],
          structuredContent: { ran: body.name },
        },
      });
    },
  });
  const view = gatewayView([todoApp()]);
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    record.push(request.clone() as Request);
    if (request.headers.get("authorization") !== AUTH.authorization) {
      return new Response("nope", { status: 401 });
    }
    return serve(request, view);
  };
  return fetchImpl;
}

/** A server that speaks only the 2025 era, like the 1.x SDK's transport. */
function legacyOnly(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("mcp-protocol-version") === "2026-07-28") {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: Unsupported protocol version: 2026-07-28",
          },
          id: null,
        },
        { status: 400 },
      );
    }
    return base(request);
  };
}

function rpc(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

async function bodyOf(
  request: Request,
): Promise<{ id: number; method: string; params: Record<string, unknown> }> {
  return (await request.json()) as {
    id: number;
    method: string;
    params: Record<string, unknown>;
  };
}

describe("the remote MCP client", () => {
  it("speaks the 2026-07-28 era first: lists and calls with the per-request headers and _meta, no session", async () => {
    const seen: Request[] = [];
    const client = new RemoteMcpClient({
      url: URL_,
      headers: AUTH,
      fetch: toolBusUpstream(seen),
    });
    const listing = await client.listTools();
    expect(listing.era).toBe("2026-07-28");
    expect(listing.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["todo_list_todos", "todo_create_todo"]),
    );
    expect(listing.truncated).toBe(false);
    const result = await client.callTool("todo_list_todos", {});
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("ran list_todos"),
    });
    expect(result.structuredContent).toEqual({ ran: "list_todos" });
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.url).toBe(URL_);
      expect(request.method).toBe("POST");
      expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(request.headers.get("mcp-session-id")).toBeNull();
      expect(request.headers.get("accept")).toBe(
        "application/json, text/event-stream",
      );
    }
    expect(seen[0]!.headers.get("mcp-method")).toBe("tools/list");
    expect(seen[1]!.headers.get("mcp-method")).toBe("tools/call");
    expect(seen[1]!.headers.get("mcp-name")).toBe("todo_list_todos");
    const sent = await bodyOf(seen[1]!);
    expect(sent.params["_meta"]).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "every-app-gateway" },
    });
    expect(client.negotiated).toBe("2026-07-28");
  });

  it("falls back to a 2025 initialize, keeps the session, and re-initializes once on a 404", async () => {
    const seen: Request[] = [];
    const base = toolBusUpstream();
    let killSession = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(request.clone() as Request);
      if (killSession && request.headers.get("mcp-session-id")) {
        killSession = false;
        return Response.json(
          {
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          },
          { status: 404 },
        );
      }
      return legacyOnly(base)(request);
    };
    const client = new RemoteMcpClient({
      url: URL_,
      headers: AUTH,
      fetch: fetchImpl,
    });
    const listing = await client.listTools();
    expect(listing.era).toBe("2025");
    expect(listing.tools.length).toBeGreaterThan(0);
    const methods = await Promise.all(
      seen.map(async (request) => (await bodyOf(request)).method),
    );
    // The modern probe, then initialize, initialized, then the list in the 2025 era.
    expect(methods).toEqual([
      "tools/list",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    const session = seen[3]!.headers.get("mcp-session-id");
    expect(session).toBeTruthy();
    expect(seen[3]!.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    expect(client.negotiated).toBe("2025");

    killSession = true;
    const result = await client.callTool("todo_list_todos", {});
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("ran list_todos"),
    });
    const after = await Promise.all(
      seen.slice(4).map(async (request) => (await bodyOf(request)).method),
    );
    expect(after).toEqual([
      "tools/call",
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(seen.at(-1)!.headers.get("mcp-session-id")).not.toBe(session);
  });

  it("sends the credential only to the registered URL and follows no redirect", async () => {
    const seen: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(request.clone() as Request);
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/mcp" },
      });
    };
    const client = new RemoteMcpClient({
      url: URL_,
      headers: AUTH,
      fetch: fetchImpl,
    });
    await expect(client.listTools()).rejects.toMatchObject({
      kind: "redirect",
      status: 302,
      message: expect.stringMatching(/follows no redirects/),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(URL_);
    expect(seen[0]!.redirect).toBe("manual");
  });

  it("reads JSON and SSE answers, dropping notifications, within the size cap", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const { id, method } = await bodyOf(new Request(input, init));
      if (method === "tools/list") {
        const frames = [
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
          `: keepalive\n\n`,
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "echo", description: "Echo.", inputSchema: { type: "object" } }] } })}\n\n`,
        ].join("");
        return new Response(frames, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return rpc(id, { content: [{ type: "text", text: "x".repeat(2000) }] });
    };
    const client = new RemoteMcpClient({
      url: URL_,
      fetch: fetchImpl,
      callMaxBytes: 1024,
    });
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual(["echo"]);
    await expect(client.callTool("echo", {})).rejects.toMatchObject({
      kind: "too_large",
      message: expect.stringMatching(/larger than 1 KB/),
    });
  });

  it("follows nextCursor to the end and stops at the page cap", async () => {
    let pages = 0;
    const paged: typeof fetch = async (input, init) => {
      const { id, params } = await bodyOf(new Request(input, init));
      pages += 1;
      const cursor = Number(params["cursor"] ?? 0);
      return rpc(id, {
        tools: [{ name: `tool_${cursor}`, inputSchema: { type: "object" } }],
        ...(cursor < 2 ? { nextCursor: String(cursor + 1) } : {}),
        ttlMs: 60_000,
      });
    };
    const client = new RemoteMcpClient({ url: URL_, fetch: paged });
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
    ]);
    expect(listing.ttlMs).toBe(60_000);
    expect(listing.truncated).toBe(false);
    expect(pages).toBe(3);

    const endless: typeof fetch = async (input, init) => {
      const { id, params } = await bodyOf(new Request(input, init));
      const cursor = Number(params["cursor"] ?? 0);
      return rpc(id, {
        tools: [{ name: `t${cursor}`, inputSchema: { type: "object" } }],
        nextCursor: String(cursor + 1),
      });
    };
    const capped = await new RemoteMcpClient({
      url: URL_,
      fetch: endless,
    }).listTools();
    expect(capped.truncated).toBe(true);
    expect(capped.tools).toHaveLength(MAX_LIST_PAGES);
  });

  it("never carries the credential or the upstream body in an error", async () => {
    const leaky: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const auth = request.headers.get("authorization");
      return new Response(
        `Server error. You sent ${auth}; the token ${TOKEN} is wrong.\nTrace: ${"y".repeat(500)}`,
        {
          status: 503,
        },
      );
    };
    const client = new RemoteMcpClient({
      url: URL_,
      headers: AUTH,
      fetch: leaky,
    });
    let error: RemoteMcpError | undefined;
    try {
      await client.listTools();
    } catch (caught) {
      error = caught as RemoteMcpError;
    }
    expect(error).toBeInstanceOf(RemoteMcpError);
    expect(error!.kind).toBe("http");
    expect(error!.status).toBe(503);
    expect(error!.message).toBe("the server answered 503");
    expect(error!.message).not.toContain(TOKEN);
    expect(error!.head).not.toContain(TOKEN);
    expect(error!.head).toContain("[credential]");
    expect(error!.head!.length).toBeLessThanOrEqual(201);
  });

  it("reports 401 as unauthorized, naming OAuth when the challenge does, and 403 as forbidden", async () => {
    const oauth: typeof fetch = async () =>
      new Response("", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer resource_metadata="https://treg.example/.well-known/oauth-protected-resource"',
        },
      });
    await expect(
      new RemoteMcpClient({ url: URL_, fetch: oauth }).listTools(),
    ).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
      wantsOAuth: true,
    });
    const plain: typeof fetch = async () =>
      new Response("", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    await expect(
      new RemoteMcpClient({ url: URL_, fetch: plain }).listTools(),
    ).rejects.toMatchObject({
      kind: "unauthorized",
      wantsOAuth: false,
    });
    const forbidden: typeof fetch = async () =>
      new Response("", { status: 403 });
    await expect(
      new RemoteMcpClient({ url: URL_, fetch: forbidden }).listTools(),
    ).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  it("times out, reports an unreachable server, and refuses a server-to-client request", async () => {
    const slow: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    await expect(
      new RemoteMcpClient({
        url: URL_,
        fetch: slow,
        listTimeoutMs: 50,
      }).listTools(),
    ).rejects.toMatchObject({ kind: "timeout" });

    const down: typeof fetch = async () => {
      throw new TypeError(`fetch failed to ${URL_} with ${TOKEN}`);
    };
    await expect(
      new RemoteMcpClient({
        url: URL_,
        headers: AUTH,
        fetch: down,
      }).listTools(),
    ).rejects.toMatchObject({
      kind: "unreachable",
      head: expect.not.stringContaining(TOKEN),
    });

    const asking: typeof fetch = async (input, init) => {
      const { id } = await bodyOf(new Request(input, init));
      const frames = [
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "elicitation/create", params: {} })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [] } })}\n\n`,
      ].join("");
      return new Response(frames, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    await expect(
      new RemoteMcpClient({ url: URL_, fetch: asking }).listTools(),
    ).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringMatching(/elicitation\/create/),
    });
  });

  it("relays a tool error and a task answer as the gateway needs them", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const { id, params } = await bodyOf(new Request(input, init));
      if (params["name"] === "fails") {
        return rpc(id, {
          content: [{ type: "text", text: "no such thing" }],
          isError: true,
        });
      }
      if (params["name"] === "task")
        return rpc(id, { task: { taskId: "t1", status: "working" } });
      if (params["name"] === "rpc_error") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `bad args for ${TOKEN}` },
        });
      }
      return rpc(id, { tools: [] });
    };
    const client = new RemoteMcpClient({
      url: URL_,
      headers: AUTH,
      fetch: fetchImpl,
    });
    await client.listTools();
    expect(await client.callTool("fails", {})).toEqual({
      content: [{ type: "text", text: "no such thing" }],
      isError: true,
    });
    await expect(client.callTool("task", {})).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringMatching(/task/),
    });
    await expect(client.callTool("rpc_error", {})).rejects.toMatchObject({
      kind: "rpc",
      code: -32602,
      head: expect.not.stringContaining(TOKEN),
    });
  });

  it("strips every form of the credential the caller names, a Basic pair included", async () => {
    const pair = "api-login@example.com:s3cret-pw-0123";
    const leaky: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const auth = request.headers.get("authorization") ?? "";
      return new Response(
        `refused ${auth}; raw ${pair}; user api-login@example.com; pw s3cret-pw-0123; key xyzzy-key-77 Key xyzzy-key-77`,
        {
          status: 503,
        },
      );
    };
    const basic = new RemoteMcpClient({
      url: URL_,
      headers: { authorization: `Basic ${btoa(pair)}` },
      secrets: [pair, "api-login@example.com", "s3cret-pw-0123"],
      fetch: leaky,
    });
    let error: RemoteMcpError | undefined;
    try {
      await basic.listTools();
    } catch (caught) {
      error = caught as RemoteMcpError;
    }
    expect(error!.head).not.toContain("s3cret-pw-0123");
    expect(error!.head).not.toContain("api-login@example.com");
    expect(error!.head).not.toContain(btoa(pair));
    const header = new RemoteMcpClient({
      url: URL_,
      headers: { "X-Api-Key": "Key xyzzy-key-77" },
      secrets: ["xyzzy-key-77"],
      fetch: leaky,
    });
    try {
      await header.listTools();
    } catch (caught) {
      error = caught as RemoteMcpError;
    }
    expect(error!.head).not.toContain("xyzzy-key-77");
  });

  it("stops reading an SSE answer at the response, reads CRLF frames, and bounds a listing as a whole", async () => {
    // A stream that never closes after the answer: the call must not wait for it.
    const heldOpen: typeof fetch = async (input, init) => {
      const { id } = await bodyOf(new Request(input, init));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const frame = `event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [{ name: "held", inputSchema: { type: "object" } }] } })}\r\n\r\n`;
          controller.enqueue(new TextEncoder().encode(frame));
          // Never closed.
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = new RemoteMcpClient({
      url: URL_,
      fetch: heldOpen,
      listTimeoutMs: 2_000,
    });
    const started = Date.now();
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name)).toEqual(["held"]);
    expect(Date.now() - started).toBeLessThan(1_500);

    // Twenty pages, each slow: the listing's deadline is one deadline, not twenty.
    const slowPages: typeof fetch = async (input, init) => {
      const { id, params } = await bodyOf(new Request(input, init));
      const cursor = Number(params["cursor"] ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 120));
      return rpc(id, {
        tools: [{ name: `t${cursor}`, inputSchema: { type: "object" } }],
        nextCursor: String(cursor + 1),
      });
    };
    const bounded = new RemoteMcpClient({
      url: URL_,
      fetch: slowPages,
      listTimeoutMs: 400,
    });
    await expect(bounded.listTools()).rejects.toMatchObject({
      kind: "timeout",
    });

    // And one byte budget across pages.
    const bigPages: typeof fetch = async (input, init) => {
      const { id, params } = await bodyOf(new Request(input, init));
      const cursor = Number(params["cursor"] ?? 0);
      return rpc(id, {
        tools: [
          {
            name: `t${cursor}`,
            description: "x".repeat(3 * 1024 * 1024),
            inputSchema: { type: "object" },
          },
        ],
        nextCursor: String(cursor + 1),
      });
    };
    await expect(
      new RemoteMcpClient({ url: URL_, fetch: bigPages }).listTools(),
    ).rejects.toMatchObject({
      kind: "too_large",
    });
  });

  it("bounds what the server chose when it names it in an error, and refuses an answer without content", async () => {
    const chatty: typeof fetch = async (input, init) => {
      const { id, method } = await bodyOf(new Request(input, init));
      if (method === "tools/list") {
        return Response.json(
          { jsonrpc: "2.0", error: { code: -32601, message: "nope" }, id },
          { status: 200 },
        );
      }
      if (method === "initialize") {
        return rpc(id, {
          protocolVersion: `${"v".repeat(500)}\u0000${TOKEN}`,
          capabilities: {},
        });
      }
      return new Response(null, { status: 202 });
    };
    let error: RemoteMcpError | undefined;
    try {
      await new RemoteMcpClient({
        url: URL_,
        headers: AUTH,
        fetch: chatty,
      }).listTools();
    } catch (caught) {
      error = caught as RemoteMcpError;
    }
    expect(error!.kind).toBe("protocol");
    expect(error!.message.length).toBeLessThan(120);
    expect(error!.message).not.toContain("\u0000");

    const noContent: typeof fetch = async (input, init) => {
      const { id, method } = await bodyOf(new Request(input, init));
      return method === "tools/list"
        ? rpc(id, { tools: [] })
        : rpc(id, { structuredContent: { only: true } });
    };
    const client = new RemoteMcpClient({ url: URL_, fetch: noContent });
    await client.listTools();
    await expect(client.callTool("x", {})).rejects.toMatchObject({
      kind: "protocol",
      message: expect.stringMatching(/no content list/),
    });
  });
});
