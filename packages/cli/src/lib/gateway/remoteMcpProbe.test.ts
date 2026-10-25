/**
 * `mcp add`'s one look at a server, against a fake fetch: the modern
 * `tools/list` answered as JSON and as SSE, the 2025 `initialize` when
 * that isn't a result, a 401 with and without OAuth's `resource_metadata`,
 * a redirect (never followed), no answer in time, and what it sends.
 */
import { describe, expect, it } from "vitest";
import { probeRemoteMcp } from "./remoteMcpProbe";

const URL_ = "https://treg.to/mcp/";

interface Seen {
  url: string;
  init: RequestInit;
  body: Record<string, any>;
  headers: Record<string, string>;
}

/** A fetch answering each POST with the next of `answers`, recording what it was sent. */
function fakeFetch(...answers: Array<(seen: Seen) => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(url),
      init: init!,
      body: JSON.parse(String(init!.body)),
      headers: Object.fromEntries(Object.entries(init!.headers as Record<string, string>)),
    };
    seen.push(entry);
    const answer = answers[seen.length - 1];
    if (!answer) throw new Error("unexpected request");
    return answer(entry);
  }) as typeof fetch;
  return { fetcher, seen };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const sse = (...events: unknown[]) =>
  new Response(events.map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("probeRemoteMcp", () => {
  it("asks for the 2026-07-28 tools/list with no credential, and reads a JSON answer", async () => {
    const { fetcher, seen } = fakeFetch(() =>
      json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "treg" } },
        },
      }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: fetcher })).toEqual({
      outcome: "reachable",
      era: "2026-07-28",
      tools: 3,
      server: "treg",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(URL_);
    expect(seen[0]!.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(seen[0]!.headers).toEqual({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    });
    expect(seen[0]!.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "everyapp-cli", version: "0.3.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
  });

  it("reads an SSE answer, skipping notifications before the response", async () => {
    const { fetcher } = fakeFetch(() =>
      sse(
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hi" } },
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "only" }] } },
      ),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: fetcher })).toEqual({
      outcome: "reachable",
      era: "2026-07-28",
      tools: 1,
      server: null,
    });
  });

  it("falls back to a 2025 initialize when tools/list isn't a result", async () => {
    const { fetcher, seen } = fakeFetch(
      () => json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "no session" } }, 400),
      () =>
        sse({
          jsonrpc: "2.0",
          id: 2,
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "Legacy" }, capabilities: { tools: {} } },
        }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: fetcher })).toEqual({
      outcome: "reachable",
      era: "2025-06-18",
      tools: null,
      server: "Legacy",
    });
    expect(seen[1]!.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "everyapp-cli", version: "0.3.0" } },
    });
    expect(seen[1]!.headers["mcp-method"]).toBeUndefined();
  });

  it("says a 401 asks for a credential, and OAuth when the challenge names resource_metadata", async () => {
    const plain = fakeFetch(() => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } }));
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: plain.fetcher })).toEqual({
      outcome: "needs-credential",
      status: 401,
      oauth: false,
    });
    expect(plain.seen).toHaveLength(1);
    const oauth = fakeFetch(
      () =>
        new Response("", {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer resource_metadata="https://treg.to/.well-known/oauth-protected-resource/mcp"',
          },
        }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: oauth.fetcher })).toEqual({
      outcome: "needs-credential",
      status: 401,
      oauth: true,
    });
  });

  it("never follows a redirect: a 302 is reported with where it points", async () => {
    const { fetcher, seen } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: "https://www.treg.to/mcp/" } }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: fetcher })).toEqual({
      outcome: "redirected",
      status: 302,
      location: "https://www.treg.to/mcp/",
    });
    expect(seen).toHaveLength(1);
  });

  it("gives up after its budget, and says so", async () => {
    const hang = (seen: Seen) =>
      new Promise<Response>((_resolve, reject) => {
        seen.init.signal!.addEventListener("abort", () => reject(seen.init.signal!.reason));
      });
    const { fetcher } = fakeFetch(hang);
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: fetcher, timeoutMs: 20 })).toEqual({
      outcome: "unreachable",
      reason: "it didn't answer within 10 seconds",
    });
  });

  it("says when a host doesn't resolve, and when an answer isn't MCP", async () => {
    const dns = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: dns.fetcher })).toEqual({
      outcome: "unreachable",
      reason: "its host name doesn't resolve from here",
    });
    const html = fakeFetch(
      () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } }),
      () => new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: html.fetcher })).toEqual({
      outcome: "unreachable",
      reason: "it answered, but not as an MCP server",
    });
    const missing = fakeFetch(
      () => new Response("not found", { status: 404 }),
      () => new Response("not found", { status: 404 }),
    );
    expect(await probeRemoteMcp(URL_, { version: "0.3.0", fetch: missing.fetcher })).toEqual({
      outcome: "unreachable",
      reason: "it answered 404",
    });
  });
});
