import { DurableObject } from "cloudflare:workers";

/**
 * UserSyncDO - A Durable Object for real-time sync across devices.
 *
 * One instance per user (keyed by userId). Maintains WebSocket connections
 * from all the user's devices and broadcasts sync events when mutations occur.
 */
export class UserSyncDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    if (url.pathname === "/emit" && request.method === "POST") {
      return this.handleEmit(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private handleWebSocketUpgrade(request: Request): Response {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleEmit(request: Request): Promise<Response> {
    const { event } = (await request.json()) as { event: string };
    this.broadcast(event);
    return new Response("OK");
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") {
      ws.send("pong");
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ) {
    // Cleanup handled automatically by hibernation API
  }

  async webSocketError(_ws: WebSocket, _error: unknown) {
    // Error handling - connection will be closed automatically
  }

  private broadcast(event: string) {
    const message = JSON.stringify({ event, timestamp: Date.now() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // WebSocket might be closing, ignore
      }
    }
  }
}
