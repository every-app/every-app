import { describe, it, expect, vi } from "vitest";
import { createRemoteAuthenticator } from "./remoteAuth";

const GATEWAY = "http://localhost:3000";
const LOGIN = "http://everyapp.localhost:8787";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

function reqWithCookie(cookie?: string): Request {
  return new Request("http://todo.everyapp.localhost/tasks", {
    headers: cookie ? { cookie } : {},
  });
}

describe("createRemoteAuthenticator", () => {
  it("resolves the real session from the gateway, forwarding the cookie", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["cookie"]).toBe(
        "better-auth.session=abc",
      );
      return jsonResponse({
        session: { sub: "u1", email: "real@x.com", orgId: "org1", orgRole: "owner" },
        hasAccess: true,
      });
    });
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await auth.authenticate(reqWithCookie("better-auth.session=abc"));
    expect(session).toEqual({
      sub: "u1",
      email: "real@x.com",
      orgId: "org1",
      orgRole: "owner",
    });
    // Hit the dev identity endpoint on the gateway.
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/dev/identity",
      expect.anything(),
    );
    const anyApp = {} as Parameters<typeof auth.hasAppAccess>[1];
    expect(
      await auth.hasAppAccess(
        { sub: "u1", email: "real@x.com", orgId: "org1", orgRole: "owner" },
        anyApp,
      ),
    ).toBe(true);
  });

  it("returns null and hints when there is no cookie (not logged in)", async () => {
    const onHint = vi.fn();
    const fetchImpl = vi.fn(async () => jsonResponse({ session: null }));
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onHint,
    });
    expect(await auth.authenticate(reqWithCookie())).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onHint).toHaveBeenCalledExactlyOnceWith(
      "No Gateway session yet: log in at http://everyapp.localhost:8787, then reload",
    );
  });

  it.each([
    ["expired", "Your Gateway session expired: log in again, then reload"],
    ["banned", "The Gateway rejected the session (banned)"],
  ])("says what a %s reason means", async (reason, hint) => {
    const onHint = vi.fn();
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: (async () =>
        jsonResponse({ session: null, reason })) as unknown as typeof fetch,
      onHint,
    });
    expect(await auth.authenticate(reqWithCookie("c=1"))).toBeNull();
    expect(onHint).toHaveBeenCalledExactlyOnceWith(hint);
  });

  it("returns null and hints once on a no_active_organization reason", async () => {
    const onHint = vi.fn();
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: (async () =>
        jsonResponse({ session: null, reason: "no_active_organization" })) as unknown as typeof fetch,
      onHint,
    });
    expect(await auth.authenticate(reqWithCookie("c=1"))).toBeNull();
    expect(await auth.authenticate(reqWithCookie("c=1"))).toBeNull();
    // Deduplicated: the same reason hints only once.
    expect(onHint).toHaveBeenCalledOnce();
    expect(onHint.mock.calls[0]![0]).toBe(
      "No active organization: create or pick one in the Gateway, then reload",
    );
  });

  it("returns null and hints when the gateway is unreachable", async () => {
    const onHint = vi.fn();
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      onHint,
    });
    expect(await auth.authenticate(reqWithCookie("c=1"))).toBeNull();
    expect(onHint.mock.calls[0]![0]).toBe(
      "Can't reach the local Gateway at http://localhost:3000\nECONNREFUSED. Is pnpm dev running in apps/every-app-gateway?",
    );
  });
});

describe("createRemoteAuthenticator with a personal access token", () => {
  it("forwards an epat_ bearer instead of the cookie and keeps its credential", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer epat_abc" });
      return jsonResponse({
        session: {
          sub: "u1",
          email: "real@x.com",
          orgId: "org1",
          orgRole: "owner",
          credential: {
            kind: "pat",
            channel: "api",
            actor: "pat:tok1",
            scopes: ["mcp:read"],
          },
        },
        hasAccess: true,
      });
    });
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const session = await auth.authenticate(
      new Request("http://todo.everyapp.localhost/mcp", {
        method: "POST",
        headers: { authorization: "Bearer epat_abc", cookie: "c=1" },
      }),
    );
    expect(session?.credential).toEqual({
      kind: "pat",
      channel: "api",
      actor: "pat:tok1",
      scopes: ["mcp:read"],
    });
  });

  it("never forwards other bearer credentials", async () => {
    const fetchImpl = vi.fn();
    const auth = createRemoteAuthenticator({
      gatewayUrl: GATEWAY,
      loginUrl: LOGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(
      await auth.authenticate(
        new Request("http://todo.everyapp.localhost/mcp", {
          headers: { authorization: "Bearer sk-live-other" },
        }),
      ),
    ).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

