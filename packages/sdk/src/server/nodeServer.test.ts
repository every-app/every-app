import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nodeServerHandler } from "./nodeServer";

// workerd's bridge to the Node server; there is none under Node.
const bridge = vi.hoisted(() => ({
  handleAsNodeRequest:
    vi.fn<(port: number, request: Request) => Promise<Response>>(),
}));
vi.mock("cloudflare:node", () => bridge);

const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;
const env = { EVERYAPP_APP_ID: "api" };

function get(path = "/hello"): Request {
  return new Request(`https://api.example.com${path}`);
}

beforeEach(() => {
  bridge.handleAsNodeRequest.mockReset();
  bridge.handleAsNodeRequest.mockImplementation(
    async () =>
      new Response("hi", { headers: { "content-type": "text/plain" } }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** Records each Response's init, to see what the runtime is told. */
function recordResponseInits(): ResponseInit[] {
  const inits: ResponseInit[] = [];
  class RecordingResponse extends Response {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init);
      inits.push(init ?? {});
    }
  }
  vi.stubGlobal("Response", RecordingResponse);
  return inits;
}

describe("nodeServerHandler", () => {
  it("boots once per isolate, on the first request, and serves every request from that server", async () => {
    const boot = vi.fn(async () => ({ port: 49152 }));
    const handler = nodeServerHandler({ boot });
    expect(boot).not.toHaveBeenCalled();

    const responses = await Promise.all([
      handler(get("/a"), env, ctx, null),
      handler(get("/b"), env, ctx, null),
      handler(get("/c"), env, ctx, null),
    ]);
    await handler(get("/d"), env, ctx, null);

    expect(boot).toHaveBeenCalledTimes(1);
    expect(boot).toHaveBeenCalledWith(env);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(bridge.handleAsNodeRequest).toHaveBeenCalledTimes(4);
    const [port, request] = bridge.handleAsNodeRequest.mock.calls[0]!;
    expect(port).toBe(49152);
    expect(new URL(request.url).pathname).toBe("/a");
  });

  it("retries a failed boot on the next request", async () => {
    const boot = vi
      .fn<() => Promise<{ port: number }>>()
      .mockRejectedValueOnce(new Error("no database"))
      .mockResolvedValue({ port: 49153 });
    const handler = nodeServerHandler({ boot });

    const [first, second] = await Promise.allSettled([
      handler(get(), env, ctx, null),
      handler(get(), env, ctx, null),
    ]);
    // Requests waiting on the failed boot fail with it.
    expect(first).toMatchObject({
      status: "rejected",
      reason: { message: "no database" },
    });
    expect(second).toMatchObject({
      status: "rejected",
      reason: { message: "no database" },
    });
    expect(bridge.handleAsNodeRequest).not.toHaveBeenCalled();

    const retried = await handler(get(), env, ctx, null);
    expect(retried.status).toBe(200);
    expect(boot).toHaveBeenCalledTimes(2);
    expect(bridge.handleAsNodeRequest.mock.calls[0]![0]).toBe(49153);
  });

  it("turns a boot that throws before its promise into a failed boot too", async () => {
    const boot = vi
      .fn<() => Promise<{ port: number }>>()
      .mockImplementationOnce(() => {
        throw new Error("sync");
      })
      .mockResolvedValue({ port: 49154 });
    const handler = nodeServerHandler({ boot });

    await expect(handler(get(), env, ctx, null)).rejects.toThrow("sync");
    expect((await handler(get(), env, ctx, null)).status).toBe(200);
  });

  it("drops Set-Cookie and keeps the rest of the Node response", async () => {
    const headers = new Headers({
      "content-type": "application/json",
      "x-powered-by": "Express",
    });
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "theme=dark");
    bridge.handleAsNodeRequest.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 201,
        statusText: "Created",
        headers,
      }),
    );
    const handler = nodeServerHandler({ boot: async () => ({ port: 1 }) });

    const response = await handler(get(), env, ctx, null);
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("x-powered-by")).toBe("Express");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("passes a body Node already encoded through as is, and lets the runtime encode the rest", async () => {
    const encoded = new Uint8Array([0x1b, 0x2a, 0x00, 0xff]);
    bridge.handleAsNodeRequest.mockResolvedValueOnce(
      new Response(encoded, {
        headers: {
          "content-encoding": "br",
          "content-type": "application/json",
        },
      }),
    );
    const handler = nodeServerHandler({ boot: async () => ({ port: 1 }) });
    const inits = recordResponseInits();

    const compressed = await handler(get("/large"), env, ctx, null);
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(new Uint8Array(await compressed.arrayBuffer())).toEqual(encoded);
    expect(inits.at(-1)).toMatchObject({ encodeBody: "manual" });

    const plain = await handler(get("/hello"), env, ctx, null);
    expect(await plain.text()).toBe("hi");
    expect(inits.at(-1)).not.toHaveProperty("encodeBody");
  });

  it("keeps a body-less status body-less", async () => {
    bridge.handleAsNodeRequest.mockResolvedValueOnce(
      new Response(null, { status: 304, headers: { etag: '"v1"' } }),
    );
    const handler = nodeServerHandler({ boot: async () => ({ port: 1 }) });

    const response = await handler(get(), env, ctx, null);
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(response.headers.get("etag")).toBe('"v1"');
  });
});
