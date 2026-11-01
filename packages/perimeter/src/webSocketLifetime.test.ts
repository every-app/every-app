import { afterEach, describe, expect, it, vi } from "vitest";
import {
  relayWebSocket,
  WEBSOCKET_LIFETIME_CLOSE,
  WEBSOCKET_MAX_LIFETIME_MS,
  type RelaySocket,
} from "./webSocketLifetime";

type Listener = (event: {
  data?: string | ArrayBuffer | ArrayBufferView;
  code?: number;
  reason?: string;
}) => void;

/** A Workers-shaped socket: accept, send, close, and events we fire by hand. */
class FakeSocket implements RelaySocket {
  accepted = false;
  sent: unknown[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Listener[]>();
  accept() {
    this.accepted = true;
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.closedWith) throw new Error("closed");
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    if (this.closedWith) throw new Error("already closed");
    this.closedWith = { code, reason };
  }
  addEventListener(type: "message" | "close" | "error", listener: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: "message" | "close" | "error", event: Parameters<Listener>[0]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** The runtime's constructor: a pair of connected sockets, keyed 0 and 1. */
let lastPair: { client: FakeSocket; server: FakeSocket } | null = null;
class FakeWebSocketPair {
  0: FakeSocket;
  1: FakeSocket;
  constructor() {
    this[0] = new FakeSocket();
    this[1] = new FakeSocket();
    lastPair = { client: this[0], server: this[1] };
  }
}

/** Node's Response refuses status 101 and has no webSocket; the Workers runtime's takes both. */
class WorkersResponse extends Response {
  constructor(
    body?: BodyInit | null,
    init?: ResponseInit & { webSocket?: unknown },
  ) {
    const { status, webSocket, ...rest } = init ?? {};
    super(body, status === 101 ? rest : init);
    if (status === 101) {
      Object.defineProperty(this, "status", { value: 101 });
      Object.defineProperty(this, "webSocket", { value: webSocket });
    }
  }
}

function handshake(appSocket: FakeSocket, headers?: HeadersInit) {
  return new Response(null, {
    status: 101,
    headers,
    webSocket: appSocket,
  } as unknown as ResponseInit) as Response & { webSocket?: unknown };
}

describe("relayWebSocket", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    lastPair = null;
  });

  function workers() {
    vi.stubGlobal("Response", WorkersResponse);
    vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
  }

  it("passes a 101 through when the runtime has no WebSocketPair or the response no socket", () => {
    const original = new Response(null);
    Object.defineProperty(original, "status", { value: 101 });
    expect(relayWebSocket(original)).toBe(original);

    vi.stubGlobal("WebSocketPair", FakeWebSocketPair);
    expect(relayWebSocket(original)).toBe(original);
  });

  it("hands the client the pair's end, accepts both sides and relays frames both ways", () => {
    workers();
    const app = new FakeSocket();
    const res = relayWebSocket(
      handshake(app, { "sec-websocket-protocol": "chat" }),
    ) as Response & { webSocket?: unknown };

    expect(res.status).toBe(101);
    expect(res.webSocket).toBe(lastPair!.client);
    expect(res.webSocket).not.toBe(app);
    expect(res.headers.get("sec-websocket-protocol")).toBe("chat");
    expect(app.accepted).toBe(true);
    expect(lastPair!.server.accepted).toBe(true);

    lastPair!.server.fire("message", { data: "from client" });
    expect(app.sent).toEqual(["from client"]);
    const bytes = new Uint8Array([1, 2, 3]);
    app.fire("message", { data: bytes });
    expect(lastPair!.server.sent).toEqual([bytes]);
  });

  it("closes both ends with a normal close and a reason when the lifetime is up", () => {
    vi.useFakeTimers();
    workers();
    const app = new FakeSocket();
    relayWebSocket(handshake(app));

    vi.advanceTimersByTime(WEBSOCKET_MAX_LIFETIME_MS - 1);
    expect(app.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    expect(app.closedWith).toEqual(WEBSOCKET_LIFETIME_CLOSE);
    expect(lastPair!.server.closedWith).toEqual(WEBSOCKET_LIFETIME_CLOSE);
    expect(WEBSOCKET_LIFETIME_CLOSE.code).toBe(1000);
    expect(WEBSOCKET_MAX_LIFETIME_MS).toBe(15 * 60 * 1000);

    // Frames after the close go nowhere, and nothing throws.
    app.fire("message", { data: "late" });
    expect(lastPair!.server.sent).toEqual([]);
  });

  it("takes a shorter lifetime, and clears the timer once a side has closed", () => {
    vi.useFakeTimers();
    workers();
    const app = new FakeSocket();
    relayWebSocket(handshake(app), { maxLifetimeMs: 1000 });
    lastPair!.server.fire("close", { code: 1000, reason: "bye" });
    expect(app.closedWith).toEqual({ code: 1000, reason: "bye" });
    // The timer fired on a closed relay would throw in FakeSocket.
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });

  it("repeats a close code the protocol lets it send, and sends none for 1005/1006", () => {
    workers();
    for (const [code, expected] of [
      [4001, 4001],
      [1001, 1001],
      [1005, undefined],
      [1006, undefined],
      [undefined, undefined],
    ] as const) {
      const app = new FakeSocket();
      relayWebSocket(handshake(app));
      app.fire("close", { code, reason: "r" });
      expect(lastPair!.server.closedWith?.code, String(code)).toBe(expected);
    }
  });

  it("closes the other side with 1011 on an error or a failed send", () => {
    workers();
    const app = new FakeSocket();
    relayWebSocket(handshake(app));
    const { server } = lastPair!;
    app.fire("error", {});
    expect(server.closedWith?.code).toBe(1011);
    expect(app.closedWith?.code).toBe(1011);

    const app2 = new FakeSocket();
    relayWebSocket(handshake(app2));
    const server2 = lastPair!.server;
    server2.closedWith = { code: 1000 }; // send() will throw
    app2.fire("message", { data: "x" });
    expect(app2.closedWith?.code).toBe(1011);
  });

  it("strips Domain from the handshake's cookies and keeps the rest", () => {
    workers();
    const headers = new Headers({ "x-app": "1" });
    headers.append("set-cookie", "prefs=dark; Domain=example.com; Path=/");
    headers.append("set-cookie", "theme=light; Path=/");
    const res = relayWebSocket(handshake(new FakeSocket(), headers));
    expect(res.headers.getSetCookie()).toEqual([
      "prefs=dark; Path=/",
      "theme=light; Path=/",
    ]);
    expect(res.headers.get("x-app")).toBe("1");
  });
});
