/**
 * The WebSocket lifetime the gateway enforces.
 *
 * The perimeter authorizes a WebSocket once, at the handshake: the identity
 * it mints lives 120 seconds, but the socket it opens would live until one
 * side hangs up, so a member removed from the organization (or whose role
 * dropped below what the app's `access` requires) kept an open chat until
 * the app closed it. Every app copied a 15-minute timer for that (OpenSEO
 * `samSocketLifetime.ts`, CRM `runtime/socketLifetime.ts`, the inbox).
 * The gateway does it once, here: instead of handing the app's 101 to the
 * client, it keeps the app's socket, gives the client the other end of a
 * `WebSocketPair`, relays frames both ways, and closes both this long
 * after the handshake. The client reconnects through the gateway, which
 * signs a fresh identity or refuses someone it no longer lets in.
 *
 * The close is a normal one (1000) with a reason, not a 4xxx: the Agents
 * SDK's client treats 4xxx as terminal and stops reconnecting. Nothing
 * else about the socket changes: subprotocol and extension headers are the
 * app's, frames are forwarded as they arrive, and either side closing
 * closes the other with the same code where the protocol allows it.
 *
 * Only the Workers runtime has `WebSocketPair` and a `webSocket` on a 101;
 * `everyapp dev` raw-pipes upgrades at the socket level
 * (`packages/cli/src/commands/dev/proxy.ts`) and enforces no lifetime.
 * Closing a socket the moment a member is removed needs a registry of open
 * relays (a Durable Object the gateway doesn't have yet): see TODO.md
 * "Platform shortcuts (2026-10-26)/L7 gateway-runtime".
 */
import { stripSetCookieDomains } from "./headers";

/** How long a proxied WebSocket stays open, whatever the app does. */
export const WEBSOCKET_MAX_LIFETIME_MS = 15 * 60 * 1000;

/** The close the gateway sends when the lifetime is up; clients reconnect. */
export const WEBSOCKET_LIFETIME_CLOSE = {
  code: 1000,
  reason: "Reconnecting: sessions renew their sign-in every 15 minutes.",
} as const;

/**
 * The slice of the Workers `WebSocket` the relay uses. Typed here, not from
 * the Workers types: the CLI compiles this package without them.
 */
export interface RelaySocket {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: {
      data?: string | ArrayBuffer | ArrayBufferView;
      code?: number;
      reason?: string;
    }) => void,
  ): void;
}

type WebSocketPairCtor = new () => Record<string, RelaySocket>;

interface RelayGlobals {
  WebSocketPair?: WebSocketPairCtor;
}

/**
 * Whether a close code may be passed to `close()`: the protocol reserves
 * 1005 and 1006 (no code, abnormal closure) for the runtime to report, and
 * `close(1005)` throws. Anything else the far side said is repeated.
 */
function isSendableCloseCode(code: number | undefined): code is number {
  return (
    typeof code === "number" &&
    code !== 1005 &&
    code !== 1006 &&
    code !== 1015 &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1011) ||
      (code >= 3000 && code <= 4999))
  );
}

function closeQuietly(
  socket: RelaySocket,
  code: number | undefined,
  reason: string | undefined,
): void {
  try {
    if (isSendableCloseCode(code)) socket.close(code, reason);
    else socket.close();
  } catch {
    // Already closing or closed.
  }
}

export interface RelayOptions {
  /** Defaults to {@link WEBSOCKET_MAX_LIFETIME_MS}. */
  maxLifetimeMs?: number;
}

/**
 * Relay the app's accepted WebSocket to a new client-side socket and close
 * both when the lifetime is up. Returns the 101 to answer the client with:
 * the app's handshake headers, `Domain` stripped from any `Set-Cookie`
 * (browsers honour a handshake's cookies, and a first-party app could
 * otherwise plant a parent-domain one), around the pair's client end.
 *
 * Returns the response as is when there is nothing to relay: no
 * `webSocket` on it, or no `WebSocketPair` in this runtime (Node, where a
 * 101 can't be rebuilt anyway).
 */
export function relayWebSocket(
  response: Response,
  options: RelayOptions = {},
): Response {
  const appSocket = (response as Response & { webSocket?: RelaySocket | null })
    .webSocket;
  const WebSocketPair = (globalThis as RelayGlobals).WebSocketPair;
  if (!appSocket || !WebSocketPair) return response;

  const [client, server] = Object.values(new WebSocketPair());
  if (!client || !server) return response;
  const maxLifetimeMs = options.maxLifetimeMs ?? WEBSOCKET_MAX_LIFETIME_MS;

  server.accept();
  appSocket.accept();

  let closed = false;
  const closeBoth = (code: number | undefined, reason: string | undefined) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    closeQuietly(server, code, reason);
    closeQuietly(appSocket, code, reason);
  };
  const timer = setTimeout(
    () =>
      closeBoth(WEBSOCKET_LIFETIME_CLOSE.code, WEBSOCKET_LIFETIME_CLOSE.reason),
    maxLifetimeMs,
  );

  const pipe = (from: RelaySocket, to: RelaySocket) => {
    from.addEventListener("message", (event) => {
      if (closed || event.data === undefined) return;
      try {
        to.send(event.data);
      } catch {
        closeBoth(1011, "relay failed");
      }
    });
    from.addEventListener("close", (event) =>
      closeBoth(event.code, event.reason),
    );
    from.addEventListener("error", () => closeBoth(1011, "relay error"));
  };
  pipe(server, appSocket);
  pipe(appSocket, server);

  const headers = new Headers(response.headers);
  stripSetCookieDomains(headers);
  return new Response(null, {
    status: 101,
    statusText: response.statusText,
    headers,
    webSocket: client,
  } as ResponseInit);
}
