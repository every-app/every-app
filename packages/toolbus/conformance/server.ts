/**
 * A local ToolBus for the MCP conformance suite: the dev ToolBus (what
 * `everyapp dev` serves at `<app>.localhost/mcp`) in front of a real SDK app
 * (`everyApp` + `defineTools`), on a plain Node HTTP server. Every request
 * acts as one dev user, so the suite exercises the protocol, not auth.
 */
import { createServer, type IncomingMessage } from "node:http";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { z } from "zod";
import { defineTools, everyApp } from "@every-app/sdk/server";
import { createDevToolBus } from "../src/dev";

const ISSUER = "https://gateway.dev.localhost";
const DEV_USER = {
  sub: "dev-user",
  email: "dev@everyapp.localhost",
  orgId: "dev-org",
  orgRole: "owner",
};

const notes: string[] = [];
const tools = defineTools(
  {
    list_notes: {
      description: "List the notes.",
      risk: "read",
      input: z.object({}).strict(),
      handler: () => ({ notes }),
    },
    add_note: {
      description: "Add a note.",
      risk: "write",
      input: z.object({ text: z.string().min(1).max(200) }).strict(),
      handler: ({ text }) => {
        notes.push(text);
        return { added: text };
      },
    },
    clear_notes: {
      description: "Delete every note.",
      risk: "destructive",
      input: z.object({}).strict(),
      handler: () => {
        notes.length = 0;
        return "cleared";
      },
    },
  },
  { instructions: "Notes are plain text; list them before adding one." },
);

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

export async function startConformanceServer(port = 0): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const app = everyApp(
    async () => new Response("not found", { status: 404 }),
    { id: "notes" },
    {
      publicKeys: [await exportSPKI(keys.publicKey)],
      issuer: ISSUER,
      allowDevIdentities: true,
      tools,
    },
  );
  const bus = createDevToolBus({
    apps: [
      {
        appId: "notes",
        name: "Notes",
        baseUrl: "http://notes.localhost",
        fetcher: {
          fetch: (request) => app.fetch(request, {}, { waitUntil() {} }),
        },
      },
    ],
    privateKeyPem: await exportPKCS8(keys.privateKey),
    issuer: ISSUER,
  });

  const server = createServer((message, response) => {
    void (async () => {
      try {
        const request = await toRequest(message);
        const answer =
          new URL(request.url).pathname === "/mcp"
            ? await bus.serveAppHost(request, "notes", DEV_USER)
            : null;
        const reply = answer ?? new Response("not found", { status: 404 });
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        response.end(Buffer.from(await reply.arrayBuffer()));
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${boundPort}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
