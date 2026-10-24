/**
 * A gateway-surface ToolBus on a loopback port for the Claude Code harness
 * (listen-reopen.claude.ts): the real HTTP layer and a view that can be
 * re-read (`refresh`), so the modern era declares `listChanged: true` and
 * holds `subscriptions/listen` streams, with the hold and poll the harness
 * chooses. No app is behind it: `tools/list` never calls one, and a
 * `tools/call` on an app tool answers a canned text. Every request is
 * recorded with its outcome, and each held stream with when it opened and
 * closed, which is what the harness counts.
 */
import { createServer, type IncomingMessage } from "node:http";
import { exportPKCS8, generateKeyPair } from "jose";
import { createToolBusHttp } from "../src/http";
import type { McpPrincipal, ToolBusApp, ToolBusView } from "../src/types";
import { gatewaySurfaceView } from "../src/view";

const ISSUER = "https://gateway.harness.localhost";

const PRINCIPAL: McpPrincipal = {
  userId: "user_harness",
  email: "harness@example.com",
  organizationId: "org_harness",
  organizationName: "Harness",
  orgRole: "owner",
  credential: { kind: "pat", id: "pat_harness" },
  access: "write",
};

const NO_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/** A request the server answered, as the harness sees it. */
export interface RecordedRequest {
  at: number;
  method: string;
  status: number;
  /** `sse` for a held listen stream, `json` for everything else. */
  kind: "json" | "sse";
}

/** One held `subscriptions/listen` stream. */
export interface RecordedStream {
  openedAt: number;
  closedAt?: number;
  /** What the stream carried before it closed. */
  pushed: string[];
}

export interface HarnessServer {
  url: string;
  requests: RecordedRequest[];
  streams: RecordedStream[];
  /** Add a tool to the catalog: the next poll pushes `list_changed`. */
  addTool(name: string): void;
  close(): Promise<void>;
}

function notesApp(toolNames: string[]): ToolBusApp {
  return {
    rowId: "row_notes",
    appId: "notes",
    audience: "every-harness-notes",
    name: "Notes",
    description: "Plain-text notes.",
    baseUrl: "https://notes.harness.localhost",
    catalogHash: `sha256:${toolNames.join(",")}`,
    instructions: "Notes are plain text; list them before adding one.",
    tools: toolNames.map((name) => ({
      name,
      description: `The ${name.replace(/_/g, " ")} tool of the harness.`,
      risk: "read" as const,
      inputSchema: NO_INPUT,
    })),
  };
}

async function toRequest(message: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const body = Buffer.concat(chunks);
  return new Request(
    `http://${message.headers.host ?? "localhost"}${message.url}`,
    {
      method: message.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
    },
  );
}

export async function startHarnessServer(options: {
  listenMaxMs: number;
  listenPollMs: number;
  port?: number;
}): Promise<HarnessServer> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const toolNames = ["list_notes"];
  const requests: RecordedRequest[] = [];
  const streams: RecordedStream[] = [];

  const currentView = (): ToolBusView => ({
    ...gatewaySurfaceView(PRINCIPAL, [notesApp([...toolNames])]),
    refresh: async () => currentView(),
  });

  const serve = createToolBusHttp({
    signing: {
      privateKeyPem: await exportPKCS8(keys.privateKey),
      issuer: ISSUER,
    },
    invokeApp: async (_app, request) => {
      const body = (await request.json()) as { name: string };
      return Response.json({
        v: 1,
        catalogHash: `sha256:${toolNames.join(",")}`,
        result: { content: [{ type: "text", text: `ran ${body.name}` }] },
      });
    },
    listenPollMs: options.listenPollMs,
    listenMaxMs: options.listenMaxMs,
  });

  const server = createServer((message, response) => {
    void (async () => {
      const at = Date.now();
      const method = message.headers["mcp-method"];
      try {
        const request = await toRequest(message);
        const reply =
          new URL(request.url).pathname === "/mcp"
            ? await serve(request, currentView())
            : new Response("not found", { status: 404 });
        const sse = reply.headers.get("content-type") === "text/event-stream";
        requests.push({
          at,
          method: typeof method === "string" ? method : "?",
          status: reply.status,
          kind: sse ? "sse" : "json",
        });
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        if (!sse || !reply.body) {
          response.end(Buffer.from(await reply.arrayBuffer()));
          return;
        }
        const stream: RecordedStream = { openedAt: at, pushed: [] };
        streams.push(stream);
        const decoder = new TextDecoder();
        const reader = reply.body.getReader();
        // The client going away ends the held stream on the ToolBus too.
        response.on("close", () => {
          reader.cancel().catch(() => undefined);
        });
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const pushed = /"method":"([^"]+)"|"resultType":"(\w+)"/.exec(text);
            if (pushed) stream.pushed.push(pushed[1] ?? `result:${pushed[2]}`);
            if (!response.destroyed) response.write(value);
          }
        } finally {
          stream.closedAt = Date.now();
          if (!response.destroyed) response.end();
        }
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    streams,
    addTool: (name) => {
      toolNames.push(name);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
