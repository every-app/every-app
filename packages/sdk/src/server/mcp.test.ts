import { describe, it, expect } from "vitest";
import { createMcpHandler } from "./mcp";
import type { ExecutionContextLike } from "./everyApp";
import type { EveryAppUser } from "../internal";

const ctx: ExecutionContextLike = { waitUntil: () => {} };

function user(scopes: string[] = ["*"]): EveryAppUser {
  return {
    id: "user_1",
    email: "a@b.com",
    orgId: "org_1",
    orgRole: "member",
    channel: "api",
    actor: { sub: "pat:tok_1" },
    scopes,
    jti: "j1",
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/mcp", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const handler = createMcpHandler({
  name: "test-app",
  version: "1.2.3",
  instructions: "use wisely",
  tools: {
    echo: {
      description: "Echo the input",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      handler: (args) => `echo: ${String(args.text)}`,
    },
    secrets: {
      scope: "secrets:read",
      handler: () => ({ found: 2 }),
    },
    raw_content: {
      handler: () => ({ content: [{ type: "text", text: "raw" }], extra: 1 }),
    },
    explodes: {
      handler: () => {
        throw new Error("boom");
      },
    },
  },
});

async function rpc(
  body: unknown,
  caller: EveryAppUser | null = user(),
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await handler(post(body, headers), {}, ctx, caller);
  const json =
    response.status === 202 ? null : ((await response.json()) as unknown);
  return { status: response.status, json };
}

describe("createMcpHandler", () => {
  it("rejects non-POST methods with 405", async () => {
    const response = await handler(
      new Request("https://app.example.com/mcp", { method: "GET" }),
      {},
      ctx,
      user(),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects requests without an authenticated user", async () => {
    const { status, json } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      null,
    );
    expect(status).toBe(401);
    expect(json.error).toBe("unauthenticated");
  });

  it("negotiates a supported protocol version on initialize", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {},
      },
    });
    expect(json.result.protocolVersion).toBe("2025-11-25");
    expect(json.result.serverInfo).toEqual({
      name: "test-app",
      version: "1.2.3",
    });
    expect(json.result.instructions).toBe("use wisely");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("falls back to the default version when the requested one is unknown", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });

  it("rejects an unsupported MCP-Protocol-Version header with 400", async () => {
    const { status } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      user(),
      { "mcp-protocol-version": "1999-01-01" },
    );
    expect(status).toBe(400);
  });

  it("returns -32700 on unparseable bodies", async () => {
    const { json } = await rpc("not json {");
    expect(json.error.code).toBe(-32700);
  });

  it("rejects messages without jsonrpc 2.0 or with invalid ids", async () => {
    const missing = await rpc({ id: 1, method: "tools/call" });
    expect(missing.json.error.code).toBe(-32600);

    const wrongVersion = await rpc({ jsonrpc: "1.0", id: 1, method: "ping" });
    expect(wrongVersion.json.error.code).toBe(-32600);

    const badId = await rpc({ jsonrpc: "2.0", id: {}, method: "ping" });
    expect(badId.json.error.code).toBe(-32600);
  });

  it("rejects cross-origin browser requests unless allowlisted", async () => {
    const denied = await handler(
      post(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://evil.example.com" },
      ),
      {},
      ctx,
      user(),
    );
    expect(denied.status).toBe(403);

    const sameOrigin = await handler(
      post(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://app.example.com" },
      ),
      {},
      ctx,
      user(),
    );
    expect(sameOrigin.status).toBe(200);

    const allowlisting = createMcpHandler({
      name: "test-app",
      allowedOrigins: ["https://partner.example.com"],
      tools: {},
    });
    const allowed = await allowlisting(
      post(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://partner.example.com" },
      ),
      {},
      ctx,
      user(),
    );
    expect(allowed.status).toBe(200);
  });

  it("rejects batch requests", async () => {
    const { json } = await rpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(json.error.code).toBe(-32600);
  });

  it("accepts notifications with 202 and no body", async () => {
    const { status, json } = await rpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(status).toBe(202);
    expect(json).toBeNull();
  });

  it("answers ping with an empty result", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(json).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("lists tools with defaulted input schemas", async () => {
    const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["echo", "secrets", "raw_content", "explodes"]);
    const secrets = json.result.tools.find(
      (t: { name: string }) => t.name === "secrets",
    );
    expect(secrets.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("hides tools whose scope the credential lacks", async () => {
    const { json } = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      user(["notes:read"]),
    );
    const names = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("secrets");
    expect(names).toContain("echo");
  });

  it("calls a tool and wraps string results as text content", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    expect(json.result).toEqual({
      content: [{ type: "text", text: "echo: hi" }],
    });
  });

  it("serializes non-string results and passes content results through", async () => {
    const secrets = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "secrets" },
    });
    expect(secrets.json.result.content[0].text).toBe('{"found":2}');

    const raw = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "raw_content" },
    });
    expect(raw.json.result.content[0].text).toBe("raw");
    expect(raw.json.result.extra).toBe(1);
  });

  it("rejects unknown tools and out-of-scope calls with -32602", async () => {
    const unknown = await rpc({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "nope" },
    });
    expect(unknown.json.error.code).toBe(-32602);

    const denied = await rpc(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "secrets" },
      },
      user(["notes:read"]),
    );
    expect(denied.json.error.code).toBe(-32602);
    expect(denied.json.error.message).toContain("secrets:read");
  });

  it("turns thrown handler errors into isError tool results", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "explodes" },
    });
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toBe("boom");
  });

  it("returns -32601 for unknown methods", async () => {
    const { json } = await rpc({
      jsonrpc: "2.0",
      id: 9,
      method: "resources/list",
    });
    expect(json.error.code).toBe(-32601);
  });
});
