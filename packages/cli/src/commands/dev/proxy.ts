/**
 * Node HTTP plumbing for `everyapp dev`.
 *
 * The dev gateway (the real perimeter, imported from
 * "@every-app/perimeter/dev") is a `Request -> Response` handler. This module
 * adapts it to a Node http server and forwards proxied requests to the app's
 * vite dev server — preserving the original Host header so SSR sees the
 * gateway-facing host, and streaming bodies both ways.
 */
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  IDENTITY_HEADER,
  PUBLIC_HEADER,
  matchPublicRoute,
  prepareOutboundHeaders,
} from "@every-app/perimeter";
import type { PublicRoute } from "@every-app/perimeter/manifest";

/** Hop-by-hop headers that must not be forwarded between HTTP/1.1 hops. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
]);

/** Convert a Node IncomingMessage into a web Request for the gateway handler. */
export function toWebRequest(req: http.IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers.append(name, req.rawHeaders[i + 1]!);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as unknown as RequestInit["body"],
          duplex: "half",
        }
      : {}),
  } as RequestInit);
}

/** Write a web Response back to the Node response. */
export async function writeWebResponse(
  res: http.ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === "set-cookie" || HOP_BY_HOP.has(key)) return;
    headers[key] = value;
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;

  res.writeHead(response.status, headers);
  if (response.body) {
    await pipeline(Readable.fromWeb(response.body as never), res);
  } else {
    res.end();
  }
}

/**
 * Fetcher that forwards a (gateway-processed) Request to the vite dev server.
 * The original Host header is preserved so the app renders gateway-facing URLs.
 */
export function viteFetcher(
  appPort: number,
  targetHost = "127.0.0.1",
): {
  fetch(request: Request): Promise<Response>;
} {
  return {
    fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const headers: Record<string, string | string[]> = {};
      request.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key)) return;
        headers[key] = value;
      });
      headers["host"] = url.host;

      return new Promise<Response>((resolve, reject) => {
        const proxied = http.request(
          {
            host: targetHost,
            port: appPort,
            method: request.method,
            path: url.pathname + url.search,
            headers,
          },
          (upstream) => {
            const resHeaders = new Headers();
            for (let i = 0; i < upstream.rawHeaders.length; i += 2) {
              const name = upstream.rawHeaders[i]!;
              if (HOP_BY_HOP.has(name.toLowerCase())) continue;
              resHeaders.append(name, upstream.rawHeaders[i + 1]!);
            }
            const status = upstream.statusCode ?? 502;
            const bodyAllowed =
              status !== 204 && status !== 304 && request.method !== "HEAD";
            resolve(
              new Response(
                bodyAllowed
                  ? (Readable.toWeb(upstream) as unknown as ReadableStream)
                  : null,
                { status, headers: resHeaders },
              ),
            );
          },
        );
        proxied.on("error", reject);
        if (request.body) {
          Readable.fromWeb(request.body as never).pipe(proxied);
        } else {
          proxied.end();
        }
      });
    },
  };
}

interface UpgradeOptions {
  appId: string;
  appPort: number;
  /** Validated manifest routes that may be reached without an identity. */
  publicRoutes?: PublicRoute[];
  /**
   * Mint a fresh identity JWT for this upgrade (perimeter contract on the WS
   * hop). Return null for an anonymous request.
   */
  mintIdentity(request: Request): Promise<string | null>;
  /** Mint the signed marker used for anonymous public requests. */
  mintPublicMarker(): Promise<string>;
  /** Parse the Host header; first label must equal appId. */
  parseAppLabel(host: string | null): string | "";
}

/** Convert a raw Node upgrade into a Request without dropping upgrade headers. */
function toUpgradeRequest(req: http.IncomingMessage): Request {
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

/**
 * Handle an APP-subdomain WebSocket upgrade: apply the perimeter contract
 * (match public routes, strip inbound trust headers, then inject a fresh
 * verified identity or signed public marker) and raw-pipe to the app's vite
 * server. handleGatewayRequest cannot do this hop in Node because a 101
 * Response is not representable — the contract is applied here instead.
 */
export async function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: UpgradeOptions,
): Promise<void> {
  try {
    const label = opts.parseAppLabel(req.headers.host ?? null);
    if (label !== opts.appId) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return;
    }

    const request = toUpgradeRequest(req);
    const publicMatch = matchPublicRoute(
      opts.publicRoutes,
      request.method,
      new URL(request.url).pathname,
    );
    const identity = await opts.mintIdentity(request);
    if (!identity && !publicMatch.public) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
      return;
    }

    // Reuse the production header policy: credentials and every inbound trust
    // header are stripped, while an app-owned bearer credential is restored
    // only for a validated public route.
    const outboundHeaders = prepareOutboundHeaders(
      request.headers,
      publicMatch.public,
    );
    if (identity) {
      outboundHeaders.set(IDENTITY_HEADER, identity);
    } else {
      outboundHeaders.set(PUBLIC_HEADER, await opts.mintPublicMarker());
    }

    pipeUpgrade(req, socket, head, opts.appPort, { outboundHeaders });
  } catch {
    socket.destroy();
  }
}

/**
 * Raw-pipe a WebSocket upgrade to a target loopback port. Used directly for the
 * gateway's own HMR (mirror mode, no perimeter contract) and by handleUpgrade
 * for app traffic (with trust-header stripping + identity injection).
 */
export function pipeUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  targetPort: number,
  opts: {
    outboundHeaders?: Headers;
    targetHost?: string;
  } = {},
): void {
  const lines: string[] = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
  if (opts.outboundHeaders) {
    opts.outboundHeaders.forEach((value, name) => {
      lines.push(`${name}: ${value}`);
    });
  } else {
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]!}: ${req.rawHeaders[i + 1]!}`);
    }
  }

  const target = net.connect(targetPort, opts.targetHost ?? "127.0.0.1", () => {
    target.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  const teardown = () => {
    socket.destroy();
    target.destroy();
  };
  target.on("error", teardown);
  socket.on("error", teardown);
}

/** Find a free TCP port for the internal vite dev server. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a port")));
      }
    });
  });
}

/** Poll until our internal vite dev server (loopback) answers. */
export function waitForHttp(port: number, timeoutMs = 90_000): Promise<void> {
  return waitForUrl(`http://127.0.0.1:${port}/`, timeoutMs);
}

/**
 * Poll a URL until it answers (any HTTP status = up). Uses fetch on the URL as
 * given, so the hostname's own resolution applies — e.g. a gateway on
 * `localhost:3000` is reached whether it bound IPv4 or IPv6, which a hardcoded
 * 127.0.0.1 probe would miss.
 */
export async function waitForUrl(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(
    `nothing answered at ${url} within ${timeoutMs}ms: ${String(lastError)}`,
  );
}
