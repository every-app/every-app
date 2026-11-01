import http from "node:http";
import net from "node:net";
import { PassThrough, type Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateManifest } from "@every-app/perimeter/manifest";
import { handleUpgrade } from "./proxy";

const openServers = new Set<net.Server>();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
});

function upgradeRequest(path: string): http.IncomingMessage {
  const rawHeaders = [
    "Host",
    "todo.localhost:8787",
    "Connection",
    "Upgrade",
    "Upgrade",
    "websocket",
    "Authorization",
    "Bearer app-secret",
    "Cookie",
    "session=secret",
    "X-EveryApp-Identity",
    "spoofed-identity",
    "X-EveryApp-Public",
    "spoofed-public",
    "X-EveryApp-Anything",
    "spoofed-trust",
    "Sec-WebSocket-Key",
    "dGVzdA==",
  ];
  return {
    method: "GET",
    url: path,
    rawHeaders,
    headers: {
      host: "todo.localhost:8787",
      connection: "Upgrade",
      upgrade: "websocket",
      authorization: "Bearer app-secret",
      cookie: "session=secret",
      "x-everyapp-identity": "spoofed-identity",
      "x-everyapp-public": "spoofed-public",
      "x-everyapp-anything": "spoofed-trust",
      "sec-websocket-key": "dGVzdA==",
    },
  } as unknown as http.IncomingMessage;
}

async function captureUpstreamRequest(
  run: (port: number, socket: Duplex) => Promise<void>,
): Promise<string> {
  let resolveRequest!: (request: string) => void;
  const request = new Promise<string>((resolve) => {
    resolveRequest = resolve;
  });
  const server = net.createServer((connection) => {
    let raw = "";
    connection.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.includes("\r\n\r\n")) {
        resolveRequest(raw);
        connection.end();
      }
    });
  });
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");

  const socket = new PassThrough();
  await run(address.port, socket);
  const raw = await request;
  socket.destroy();
  return raw;
}

const publicRoutes = validateManifest({
  id: "todo",
  public: [{ path: "/socket" }],
}).public;

describe("handleUpgrade", () => {
  it("allows an anonymous public WebSocket and preserves Authorization", async () => {
    const raw = await captureUpstreamRequest((appPort, socket) =>
      handleUpgrade(upgradeRequest("/socket"), socket, Buffer.alloc(0), {
        appId: "todo",
        appPort,
        publicRoutes,
        parseAppLabel: () => "todo",
        mintIdentity: async () => null,
        mintPublicMarker: async () => "fresh-public-marker",
      }),
    );

    expect(raw).toContain("authorization: Bearer app-secret\r\n");
    expect(raw).toContain("x-everyapp-public: fresh-public-marker\r\n");
    expect(raw).not.toContain("session=secret");
    expect(raw).not.toContain("spoofed-identity");
    expect(raw).not.toContain("spoofed-public");
    expect(raw).not.toContain("spoofed-trust");
  });

  it("keeps private WebSockets identity-required and strips credentials and trust headers", async () => {
    const rejected = new PassThrough();
    let rejection = "";
    rejected.on("data", (chunk) => {
      rejection += chunk.toString();
    });
    const mintPublicMarker = vi.fn(async () => "unused");

    await handleUpgrade(
      upgradeRequest("/private-socket"),
      rejected,
      Buffer.alloc(0),
      {
        appId: "todo",
        appPort: 1,
        publicRoutes,
        parseAppLabel: () => "todo",
        mintIdentity: async () => null,
        mintPublicMarker,
      },
    );
    expect(rejection).toContain("401 Unauthorized");
    expect(mintPublicMarker).not.toHaveBeenCalled();

    const raw = await captureUpstreamRequest((appPort, socket) =>
      handleUpgrade(
        upgradeRequest("/private-socket"),
        socket,
        Buffer.alloc(0),
        {
          appId: "todo",
          appPort,
          publicRoutes,
          parseAppLabel: () => "todo",
          mintIdentity: async () => "fresh-identity",
          mintPublicMarker,
        },
      ),
    );

    expect(raw).toContain("x-everyapp-identity: fresh-identity\r\n");
    expect(raw).not.toContain("authorization:");
    expect(raw).not.toContain("session=secret");
    expect(raw).not.toContain("spoofed-identity");
    expect(raw).not.toContain("spoofed-public");
    expect(raw).not.toContain("spoofed-trust");
    expect(mintPublicMarker).not.toHaveBeenCalled();
  });
});
