import { describe, expect, it, vi } from "vitest";
import { EveryAppError } from "@/lib/errors";
import type { LinkedSession, LinkedWhoami } from "@/lib/linkedDev";
import { createNdjsonSink } from "@/lib/output/events";
import { createLinkedForwarder, createLinkedIdentity, newLinkedDevNonce } from "./linked";

const WHO: LinkedWhoami = {
  user: { id: "u1", email: "ana@acme.com" },
  organization: { id: "org1", name: "Acme" },
  role: "owner",
  app: { id: "todo", rowId: "app1", name: "Todo", hostname: "todo.apps.example.com" },
  connection: { id: "mcpc_1", clientName: "everyapp dev on box" },
  hasAccess: true,
  limits: { perMinute: 120, perDay: 2000 },
};

function session(over: Partial<LinkedSession> = {}): LinkedSession {
  return {
    gateway: "https://apps.example.com",
    appId: "todo",
    routeUrl: "https://apps.example.com/linked-dev/todo",
    token: async () => "tok-1",
    invalidate: () => undefined,
    whoami: async () => WHO,
    ...over,
  };
}

describe("the linked forwarder", () => {
  const nonce = newLinkedDevNonce();

  it("forwards the SDK's call to the Gateway's linked dev route with the bearer, and without the dev identity, organization, cookie or nonce headers", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return Response.json({
        url,
        method: init?.method,
        authorization: headers.get("authorization"),
        identity: headers.get("x-everyapp-identity"),
        org: headers.get("x-everyapp-org"),
        cookie: headers.get("cookie"),
        nonce: headers.get("x-everyapp-linked-dev"),
        contentType: headers.get("content-type"),
        body: init?.body ? await new Response(init.body as never).text() : null,
      });
    });
    const forwarder = createLinkedForwarder(session(), nonce, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(forwarder.matches("/__everyapp/gateway/api/ai/openai/v1/responses")).toBe(true);
    expect(forwarder.matches("/api/ai")).toBe(false);
    const response = await forwarder.handle(
      new Request("http://todo.localhost:8787/__everyapp/gateway/api/ai/openai/v1/responses?stream=true", {
        method: "POST",
        headers: {
          "x-everyapp-linked-dev": nonce,
          "x-everyapp-identity": "dev.jwt",
          "x-everyapp-org": "dev-org",
          cookie: "a=b",
          "content-type": "application/json",
        },
        body: '{"input":"hi"}',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://apps.example.com/linked-dev/todo/api/ai/openai/v1/responses?stream=true",
      method: "POST",
      authorization: "Bearer tok-1",
      identity: null,
      org: null,
      cookie: null,
      nonce: null,
      contentType: "application/json",
      body: '{"input":"hi"}',
    });
  });

  it("refuses a web page's request and a call without this run's nonce, before any token is read", async () => {
    const fetchImpl = vi.fn();
    const token = vi.fn(async () => "tok");
    const forwarder = createLinkedForwarder(session({ token }), nonce, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const page = await forwarder.handle(
      new Request("http://todo.localhost:8787/__everyapp/gateway/api/ai/openai/v1/responses", {
        method: "POST",
        headers: { origin: "https://evil.example", "x-everyapp-linked-dev": nonce },
      }),
    );
    expect(page.status).toBe(403);
    const stale = await forwarder.handle(
      new Request("http://todo.localhost:8787/__everyapp/gateway/api/ai/openai/v1/responses", {
        method: "POST",
        headers: { "x-everyapp-linked-dev": "other" },
      }),
    );
    expect(stale.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });

  it("refreshes once on a 401 and then hands the Gateway's answer to the app, the body sent again; a down Gateway is 502", async () => {
    let calls = 0;
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? await new Response(init.body as never).text() : "");
      return calls++ === 0
        ? Response.json(
            { error: "invalid_token" },
            { status: 401, headers: { "www-authenticate": 'Bearer realm="every-app-linked-dev"' } },
          )
        : Response.json({ ok: true });
    });
    const invalidate = vi.fn();
    const forwarder = createLinkedForwarder(session({ invalidate }), nonce, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const request = () =>
      new Request("http://todo.localhost:8787/__everyapp/gateway/api/ai/openai/v1/responses", {
        method: "POST",
        headers: { "x-everyapp-linked-dev": nonce, "content-type": "application/json" },
        body: '{"input":"again"}',
      });
    expect((await forwarder.handle(request())).status).toBe(200);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(bodies).toEqual(['{"input":"again"}', '{"input":"again"}']);

    const alwaysRefused = createLinkedForwarder(session({ invalidate }), nonce, {
      fetchImpl: (async () =>
        Response.json(
          { error: "invalid_token" },
          { status: 401, headers: { "www-authenticate": 'Bearer realm="every-app-linked-dev"' } },
        )) as unknown as typeof fetch,
    });
    expect((await alwaysRefused.handle(request())).status).toBe(401);

    // The grant is gone (no new token): the app sees the Gateway's 401, not a 502.
    const revokedFetch = vi.fn(async () =>
      Response.json(
        { error: "invalid_token" },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="every-app-linked-dev"' } },
      ),
    );
    let tokens = 0;
    const revoked = createLinkedForwarder(
      session({
        invalidate: vi.fn(),
        token: async () => {
          if (tokens++ === 0) return "tok-old";
          throw new EveryAppError("LINKED_DEV_SIGNIN_FAILED", "revoked");
        },
      }),
      nonce,
      { fetchImpl: revokedFetch as unknown as typeof fetch },
    );
    const gone = await revoked.handle(request());
    expect(gone.status).toBe(401);
    expect(await gone.json()).toEqual({ error: "invalid_token" });

    // A provider's 401 passed through by the AI proxy is the app's to see: no retry.
    const providerRefusal = vi.fn(async () =>
      Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
    );
    const passThrough = createLinkedForwarder(session({ invalidate: vi.fn() }), nonce, {
      fetchImpl: providerRefusal as unknown as typeof fetch,
    });
    expect((await passThrough.handle(request())).status).toBe(401);
    expect(providerRefusal).toHaveBeenCalledOnce();

    const down = createLinkedForwarder(session(), nonce, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const unreachable = await down.handle(request());
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ error: "gateway_unreachable" });
  });
});

describe("the linked identity", () => {
  it("is the Gateway's member, re-read every minute, and no session once the Gateway refuses", async () => {
    let now = 0;
    const events: Array<Record<string, unknown>> = [];
    const out = createNdjsonSink((line) => events.push(JSON.parse(line)));
    let refuse = false;
    const whoami = vi.fn(async () => {
      if (refuse) {
        throw new EveryAppError("LINKED_DEV_REFUSED", "revoked", { data: { status: 401 } });
      }
      return WHO;
    });
    const identity = createLinkedIdentity(session({ whoami }), { out, now: () => now });
    const request = new Request("http://todo.localhost:8787/");
    await expect(identity.authenticator.authenticate(request)).resolves.toEqual({
      sub: "u1",
      email: "ana@acme.com",
      orgId: "org1",
      orgRole: "owner",
      orgName: "Acme",
    });
    await expect(identity.authenticator.hasAppAccess(WHO as never, {} as never)).resolves.toBe(true);
    now = 30_000;
    await identity.authenticator.authenticate(request);
    expect(whoami).toHaveBeenCalledOnce();
    now = 61_000;
    refuse = true;
    await expect(identity.authenticator.authenticate(request)).resolves.toBeNull();
    await expect(identity.authenticator.hasAppAccess(WHO as never, {} as never)).resolves.toBe(false);
    expect(whoami).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "LINKED_DEV_REFUSED", message: "revoked" }),
    );
    // The refusal is said once, not on every request.
    now = 130_000;
    await identity.authenticator.authenticate(request);
    expect(events.filter((event) => event["code"] === "LINKED_DEV_REFUSED")).toHaveLength(1);
  });
});
