import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openLinkedDevStore } from "@/lib/linkedDev/store";
import { createNdjsonSink } from "@/lib/output/events";
import { openGatewayApi, toolAnswer } from ".";

const GATEWAY = "https://apps.example.com";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-api-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const out = () => createNdjsonSink(() => undefined);
const store = () => openLinkedDevStore(path.join(dir, "gateways.json"));

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A Gateway whose /mcp answers `answer` to every request, recording what was sent. */
function fakeGateway(answer: (body: Record<string, unknown>) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    return answer(body);
  });
  return { sent, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const rpcResult = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });

describe("openGatewayApi", () => {
  it("calls a tool on <gateway>/mcp with EVERYAPP_TOKEN, as one stateless 2026-07-28 request, and answers its structured content", async () => {
    const { sent, fetchImpl } = fakeGateway(() =>
      rpcResult({ content: [{ type: "text", text: "{}" }], structuredContent: { members: [{ email: "ann@example.com" }] } }),
    );
    const api = await openGatewayApi({
      flags: { gateway: `${GATEWAY}/admin` },
      out: out(),
      env: { EVERYAPP_TOKEN: "epat_abc" },
      store: store(),
      fetchImpl,
    });
    expect(api.gateway).toBe(GATEWAY);
    expect(await api.call("everyapp_workspace_users")).toEqual({ members: [{ email: "ann@example.com" }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${GATEWAY}/mcp`);
    expect(sent[0]!.headers).toMatchObject({
      authorization: "Bearer epat_abc",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "everyapp_workspace_users",
    });
    expect(sent[0]!.body).toMatchObject({
      method: "tools/call",
      params: {
        name: "everyapp_workspace_users",
        arguments: {},
        _meta: { "io.modelcontextprotocol/clientInfo": { name: "everyapp-cli" } },
      },
    });
  });

  it("turns a tool's refusal into GATEWAY_TOOL_ERROR with the Gateway's code, and a 401 into GATEWAY_REFUSED", async () => {
    let status = 200;
    const { fetchImpl } = fakeGateway(() =>
      status === 401
        ? Response.json({ error: "invalid_token" }, { status: 401 })
        : rpcResult({ content: [{ type: "text", text: "LAST_OWNER: the last owner is never demoted" }], isError: true }),
    );
    const api = await openGatewayApi({ flags: { gateway: GATEWAY }, out: out(), env: { EVERYAPP_TOKEN: "epat_abc" }, store: store(), fetchImpl });
    await expect(api.call("everyapp_workspace_role", { user: "a@b.c", role: "member" })).rejects.toMatchObject({
      code: "GATEWAY_TOOL_ERROR",
      message: "the last owner is never demoted",
      data: { code: "LAST_OWNER", tool: "everyapp_workspace_role" },
    });
    status = 401;
    await expect(api.call("everyapp_workspace_users")).rejects.toMatchObject({ code: "GATEWAY_REFUSED", data: { status: 401 } });
  });

  it("refuses a Gateway URL that isn't https, before any token is sent", async () => {
    const { sent, fetchImpl } = fakeGateway(() => rpcResult({}));
    await expect(
      openGatewayApi({ flags: { gateway: "http://apps.example.com" }, out: out(), env: { EVERYAPP_TOKEN: "epat_abc" }, store: store(), fetchImpl }),
    ).rejects.toMatchObject({ code: "INVALID_GATEWAY_URL" });
    expect(sent).toEqual([]);
  });

  it("uses the one Gateway this machine signed in to, refreshing a stale token, and asks which of several", async () => {
    const sessions = store();
    sessions.put({
      gateway: GATEWAY,
      appId: "mcp",
      clientId: "client-1",
      refreshToken: "refresh-1",
      accessToken: "stale",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      linkedAt: new Date().toISOString(),
    });
    const sent: Sent[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: GATEWAY,
          authorization_endpoint: `${GATEWAY}/oauth/authorize`,
          token_endpoint: `${GATEWAY}/oauth/token`,
        });
      }
      if (target.endsWith("/oauth/token")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("refresh_token");
        expect(form.get("resource")).toBe(`${GATEWAY}/mcp`);
        return Response.json({ access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600 });
      }
      sent.push({ url: target, headers: Object.fromEntries(new Headers(init?.headers).entries()), body: {} });
      return rpcResult({ structuredContent: { ok: true } });
    }) as typeof fetch;
    const api = await openGatewayApi({ flags: {}, out: out(), env: {}, store: sessions, fetchImpl });
    expect(api.gateway).toBe(GATEWAY);
    expect(await api.call("everyapp_workspace_show")).toEqual({ ok: true });
    expect(sent[0]!.headers["authorization"]).toBe("Bearer fresh");
    expect(sessions.get(GATEWAY, "mcp")).toMatchObject({ accessToken: "fresh", refreshToken: "refresh-2" });

    sessions.put({ ...sessions.get(GATEWAY, "mcp")!, gateway: "https://other.example.com" });
    await expect(openGatewayApi({ flags: {}, out: out(), env: {}, store: sessions, fetchImpl })).rejects.toMatchObject({
      code: "GATEWAY_AMBIGUOUS",
    });
  });
});

describe("a stored sign-in", () => {
  const signedIn = (expiresIn: number) => {
    const sessions = store();
    sessions.put({
      gateway: GATEWAY,
      appId: "mcp",
      clientId: "client-1",
      refreshToken: "refresh-1",
      accessToken: "access-1",
      expiresAt: new Date(Date.now() + expiresIn).toISOString(),
      linkedAt: new Date().toISOString(),
    });
    return sessions;
  };
  const metadata = () =>
    Response.json({ issuer: GATEWAY, authorization_endpoint: `${GATEWAY}/oauth/authorize`, token_endpoint: `${GATEWAY}/oauth/token` });

  it("on a 401, refreshes once and retries before giving the sign-in up", async () => {
    const sessions = signedIn(3_600_000);
    const bearers: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/.well-known/oauth-authorization-server")) return metadata();
      if (target.endsWith("/oauth/token")) return Response.json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 });
      const bearer = new Headers(init?.headers).get("authorization")!;
      bearers.push(bearer);
      return bearer === "Bearer access-1" ? Response.json({ error: "invalid_token" }, { status: 401 }) : rpcResult({ structuredContent: { ok: true } });
    }) as typeof fetch;
    const api = await openGatewayApi({ flags: {}, out: out(), env: {}, store: sessions, fetchImpl });
    expect(await api.call("everyapp_workspace_show")).toEqual({ ok: true });
    expect(bearers).toEqual(["Bearer access-1", "Bearer access-2"]);
    expect(sessions.get(GATEWAY, "mcp")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("keeps the sign-in when the refresh fails on the network, and forgets it when the token endpoint refuses the grant", async () => {
    const sessions = signedIn(-1000);
    let token: "down" | "invalid_grant" = "down";
    const fetchImpl = (async (url: string | URL) => {
      const target = String(url);
      if (target.endsWith("/.well-known/oauth-authorization-server")) return metadata();
      if (target.endsWith("/oauth/token")) {
        if (token === "down") throw new TypeError("fetch failed");
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return rpcResult({ structuredContent: { ok: true } });
    }) as typeof fetch;
    const api = await openGatewayApi({ flags: {}, out: out(), env: {}, store: sessions, fetchImpl });
    await expect(api.call("everyapp_workspace_show")).rejects.toThrow("fetch failed");
    expect(sessions.get(GATEWAY, "mcp")).not.toBeNull();
    token = "invalid_grant";
    await expect(api.call("everyapp_workspace_show")).rejects.toMatchObject({ code: "OAUTH_SIGNIN_FAILED" });
    expect(sessions.get(GATEWAY, "mcp")).toBeNull();
  });
});

describe("toolAnswer", () => {
  it("parses a text answer that is JSON, and keeps prose as text", () => {
    expect(toolAnswer(GATEWAY, "x", { content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(toolAnswer(GATEWAY, "x", { content: [{ type: "text", text: "hello" }] })).toEqual({ text: "hello" });
  });
});
