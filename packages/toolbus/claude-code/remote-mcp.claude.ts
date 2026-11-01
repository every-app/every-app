/**
 * Claude Code against a remote MCP server served through the ToolBus, as
 * the gateway serves an MCP app added by URL (docs/design/2026-10-mcp-by-url.md,
 * section 11), with a real `claude -p` (needs the `claude` CLI logged in;
 * spends a few cents; not run in CI). It answers one question: does a client
 * connected to the ToolBus see a remote server's tools under `<id>_<tool>`
 * names with the gateway's policy applied, call one, and read the answer,
 * with the ToolBus auditing the call once and the remote client carrying the
 * server's own credential and nothing of the caller's?
 *
 * The chain is the gateway's without D1 and the Worker: Claude Code → the
 * real ToolBus HTTP layer on a loopback port → `invokeApp`, which answers
 * the internal tools contract the way the gateway's in-process remote app
 * does (apps/every-app-gateway/src/server/remote-mcp/: the identity
 * verified for this one call, the local name mapped to the server's, the
 * result relayed under the catalog's hash) → `RemoteMcpClient` → the
 * remote server. The app's catalog is the server's listing through
 * `normalizeRemoteCatalog`, then through the ToolBus's own
 * `normalizeCatalog` the way the catalog sync takes the contract's answer.
 *
 * Two cases, each with its own servers, ports and Claude Code session:
 *
 *   fake  a fake remote server on node:http that speaks the 2026-07-28 era
 *         only (anything else gets the SDK's "Unsupported protocol version"
 *         400), requires its own bearer, and lists three camelCase tools:
 *         lookupPort (readOnlyHint), setBerth (no hints) and scuttle
 *         (destructiveHint). It answers `tools/call` as an SSE stream with
 *         a progress notification ahead of the result. Every request it
 *         gets is recorded with its headers and body.
 *   live  a public no-auth MCP server: the first of DeepWiki and the
 *         Cloudflare docs server whose `tools/list` answers within 15 s.
 *         When neither does, the case is skipped at run time and the
 *         report says why. REMOTE_LIVE=cfdocs (or deepwiki) tries only
 *         that one.
 *
 * Reports go to REMOTE_REPORT_DIR (default the system's temp directory).
 *
 *   pnpm -C packages/toolbus test:claude-code remote-mcp
 *   REMOTE_MODEL=opus pnpm -C packages/toolbus test:claude-code remote-mcp
 *   REMOTE_LIVE=cfdocs pnpm -C packages/toolbus test:claude-code remote-mcp -t live
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogHash,
  IDENTITY_HEADER,
  remoteMcpAuthHeaders,
  TOOLS_PROTOCOL_VERSION,
  verifyIdentityJwt,
  type EveryAppUser,
  type RemoteMcpBlock,
  type ToolCallResultV1,
  type ToolsErrorCodeV1,
} from "@every-app/sdk/internal";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeCatalog } from "../src/catalog";
import { createArgumentsDigester } from "../src/digest";
import { createToolBusHttp } from "../src/http";
import {
  RemoteMcpClient,
  RemoteMcpError,
  type UpstreamListing,
} from "../src/remote/client";
import {
  normalizeRemoteCatalog,
  type NormalizedRemoteCatalog,
} from "../src/remote/normalize";
import type {
  McpPrincipal,
  ToolBusApp,
  ToolBusView,
  ToolCallAuditEvent,
} from "../src/types";
import { gatewaySurfaceView } from "../src/view";

const MODEL = process.env["REMOTE_MODEL"] ?? "sonnet";
const MINUTE = 60_000;
const ISSUER = "https://gateway.harness.localhost";
/** The bearer Claude Code sends the ToolBus: no remote server may ever see it. */
const TOOLBUS_TOKEN = `harness-${crypto.randomUUID()}`;
/**
 * The fake server's credential, as the gateway holds `HARBOR_MCP_TOKEN`:
 * sent only to the fake, never shown to Claude.
 */
const UPSTREAM_TOKEN = `upstream-${crypto.randomUUID()}`;
const MODERN = "2026-07-28";

const PRINCIPAL: McpPrincipal = {
  userId: "user_harness",
  email: "harness@example.com",
  organizationId: "org_harness",
  organizationName: "Harness",
  orgRole: "owner",
  credential: { kind: "pat", id: "pat_harness" },
  access: "write",
};

/** The registration's risk rules: the default, no per-tool overrides. */
const BLOCK: Pick<RemoteMcpBlock, "risk" | "tools"> = {
  risk: "annotations",
  tools: {},
};

// ---------------------------------------------------------------------------
// The fake remote server

const HARBOR_ID = "harbor";
const HARBOR_NAME = "Harbor";
/** The part of the fixed answer Claude's final text must carry. */
const ANSWER_MARKER = "ORCA-4471";
const FAKE_PROMPT =
  "Use the harbor tools on the everyapp MCP server to look up the details of the port of Marsaxlokk, then report exactly what came back: quote the JSON as it came back.";

/** What `lookupPort` answers, whatever port it is asked about. */
function portDetails(port: string) {
  return {
    port,
    harbormaster: "Captain Rosa Ellul",
    pilotCode: ANSWER_MARKER,
    freeBerths: 3,
    highTide: "14:20",
  };
}

/** What the fake lists: camelCase names, so the normalization shows. */
const HARBOR_TOOLS = [
  {
    name: "lookupPort",
    title: "Look up a port",
    description:
      "A port's details: its harbormaster, pilot code, free berths and the next high tide.",
    inputSchema: {
      type: "object",
      properties: { port: { type: "string", description: "The port's name." } },
      required: ["port"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "setBerth",
    description: "Assign a vessel to a berth in a port.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "string" },
        vessel: { type: "string" },
        berth: { type: "integer" },
      },
      required: ["port", "vessel", "berth"],
    },
  },
  {
    name: "scuttle",
    description: "Sink a vessel on purpose. It cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { vessel: { type: "string" } },
      required: ["vessel"],
    },
    annotations: { destructiveHint: true },
  },
];

// ---------------------------------------------------------------------------
// The live candidates, in the order they are tried

interface LiveCandidate {
  appId: string;
  name: string;
  description: string;
  url: string;
  prompt: string;
}

const LIVE_CANDIDATES: LiveCandidate[] = [
  {
    appId: "deepwiki",
    name: "DeepWiki",
    description:
      "DeepWiki's public MCP server: generated wikis of GitHub repositories.",
    url: "https://mcp.deepwiki.com/mcp",
    prompt:
      "Use the deepwiki tools on the everyapp MCP server to read the wiki structure of the GitHub repository modelcontextprotocol/typescript-sdk. Call the structure tool once and nothing else, then list the wiki's top-level sections in a few short lines.",
  },
  {
    appId: "cfdocs",
    name: "Cloudflare Docs",
    description: "Cloudflare's public documentation MCP server.",
    url: "https://docs.mcp.cloudflare.com/mcp",
    prompt:
      "Use the cfdocs tools on the everyapp MCP server to find out what the CPU time limit of a Cloudflare Worker is. Search once, then answer in two sentences.",
  },
];

// ---------------------------------------------------------------------------
// Helpers

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23);
}

async function waitFor(
  what: string,
  predicate: () => boolean,
  timeoutMs: number,
  failed?: () => string | null,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return;
    const failure = failed?.();
    if (failure) throw new Error(`while waiting for ${what}: ${failure}`);
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** The first text block of a result, cut. */
function firstText(result: unknown, max = 300): string {
  if (!isRecord(result) || !Array.isArray(result["content"])) return "";
  const first = result["content"].find(
    (block) => isRecord(block) && block["type"] === "text",
  ) as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text.slice(0, max) : "";
}

/** The JSON-RPC messages in a JSON body or an SSE text. */
function messagesIn(text: string, sse: boolean): unknown[] {
  const raw = sse
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
    : [text];
  return raw.map(parseJson).filter((message) => message !== undefined);
}

async function readMessage(
  message: IncomingMessage,
): Promise<{ headers: Headers; bytes: Buffer<ArrayBuffer> }> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  return { headers, bytes: Buffer.concat(chunks) };
}

/** Every header value, for the leak checks. */
function headerValues(headers: Record<string, string>): string {
  return Object.values(headers).join("\n");
}

// ---------------------------------------------------------------------------
// What reached the remote server

/** One request to the remote server, as it saw it (the fake) or as the client sent it (live). */
interface UpstreamRequest {
  at: number;
  /** The JSON-RPC method in the body. */
  method: string;
  /** tools/call: the server's own tool name. */
  name?: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  contentType: string;
  /** tools/call: the first text block of the result. */
  answer?: string;
}

interface FakeUpstream {
  url: string;
  requests: UpstreamRequest[];
  close(): Promise<void>;
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** The fake's answer to one request: JSON, SSE, or nothing (202). */
function fakeAnswer(
  headers: Headers,
  body: unknown,
): { status: number; headers: Record<string, string>; text: string } {
  const json = (status: number, value: unknown) => ({
    status,
    headers: { "content-type": "application/json" },
    text: JSON.stringify(value),
  });
  if (headers.get("authorization") !== `Bearer ${UPSTREAM_TOKEN}`) {
    return {
      ...json(401, rpcError(null, -32001, "Unauthorized")),
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="harbor"',
      },
    };
  }
  const version = headers.get("mcp-protocol-version");
  if (version !== MODERN) {
    // What the SDK's transport answers a version it doesn't speak.
    return json(
      400,
      rpcError(
        null,
        -32000,
        `Bad Request: Unsupported protocol version: ${version ?? "(none)"}`,
      ),
    );
  }
  if (!isRecord(body) || typeof body["method"] !== "string") {
    return json(400, rpcError(null, -32700, "Parse error"));
  }
  const { id, method } = body;
  const params = isRecord(body["params"]) ? body["params"] : {};
  if (headers.get("mcp-method") !== method) {
    return json(
      400,
      rpcError(id, -32600, "Mcp-Method does not match the body's method"),
    );
  }
  if (id === undefined) return { status: 202, headers: {}, text: "" };
  if (method === "tools/list") {
    return json(200, { jsonrpc: "2.0", id, result: { tools: HARBOR_TOOLS } });
  }
  if (method !== "tools/call") {
    return json(200, rpcError(id, -32601, `Method not found: ${method}`));
  }
  const name = params["name"];
  if (headers.get("mcp-name") !== name) {
    return json(
      400,
      rpcError(id, -32600, "Mcp-Name does not match the tool called"),
    );
  }
  const args = isRecord(params["arguments"]) ? params["arguments"] : {};
  let result: ToolCallResultV1;
  if (name === "lookupPort") {
    const details = portDetails(String(args["port"] ?? "Marsaxlokk"));
    result = {
      content: [{ type: "text", text: JSON.stringify(details) }],
      structuredContent: details,
    };
  } else if (name === "setBerth") {
    result = { content: [{ type: "text", text: "Berth set." }] };
  } else if (name === "scuttle") {
    result = { content: [{ type: "text", text: "Scuttled." }] };
  } else {
    return json(200, rpcError(id, -32602, `Unknown tool: ${String(name)}`));
  }
  // An SSE answer with a notification ahead of the result: the client
  // reads past it to the message with the request's id.
  const frames = [
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progress: 1 },
    },
    { jsonrpc: "2.0", id, result },
  ]
    .map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`)
    .join("");
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: frames,
  };
}

async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: UpstreamRequest[] = [];
  const server = createServer((message, response) => {
    void (async () => {
      const at = Date.now();
      try {
        const { headers, bytes } = await readMessage(message);
        const body = parseJson(bytes.toString("utf8"));
        const answer =
          new URL(message.url ?? "/", "http://fake").pathname === "/mcp" &&
          message.method === "POST"
            ? fakeAnswer(headers, body)
            : { status: 404, headers: {}, text: "not found" };
        const method =
          isRecord(body) && typeof body["method"] === "string"
            ? body["method"]
            : "?";
        const params =
          isRecord(body) && isRecord(body["params"]) ? body["params"] : {};
        const contentType = answer.headers["content-type"] ?? "";
        const sse = contentType === "text/event-stream";
        const reply = messagesIn(answer.text, sse).find(
          (item) => isRecord(item) && "result" in item,
        );
        requests.push({
          at,
          method,
          ...(typeof params["name"] === "string"
            ? { name: params["name"] }
            : {}),
          headers: Object.fromEntries(headers),
          body,
          status: answer.status,
          contentType,
          ...(method === "tools/call" && isRecord(reply)
            ? { answer: firstText(reply["result"]) }
            : {}),
        });
        response.writeHead(answer.status, answer.headers);
        response.end(answer.text);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * `fetch` for the remote client that records what it sent and what came
 * back: for the live server, the only record of the upstream's side.
 */
function recordingFetch(sent: UpstreamRequest[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const at = Date.now();
    const body = parseJson(await request.clone().text());
    const params =
      isRecord(body) && isRecord(body["params"]) ? body["params"] : {};
    const method =
      isRecord(body) && typeof body["method"] === "string"
        ? body["method"]
        : "?";
    const response = await fetch(request);
    const contentType = response.headers.get("content-type") ?? "";
    const entry: UpstreamRequest = {
      at,
      method,
      ...(typeof params["name"] === "string" ? { name: params["name"] } : {}),
      headers: Object.fromEntries(request.headers),
      body,
      status: response.status,
      contentType,
    };
    sent.push(entry);
    if (method !== "tools/call") return response;
    // Read the call's answer for the report, and hand the client a copy.
    const text = await response.text();
    const sse = contentType.includes("text/event-stream");
    const reply = messagesIn(text, sse).find(
      (item) => isRecord(item) && "result" in item,
    );
    if (isRecord(reply)) entry.answer = firstText(reply["result"]);
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// ---------------------------------------------------------------------------
// The remote app the ToolBus serves

interface RemoteApp {
  app: ToolBusApp;
  /** The normalized catalog: the descriptors, the local → upstream map, the records. */
  catalog: NormalizedRemoteCatalog;
  listing: UpstreamListing;
  /** What the remote normalization and the ToolBus's catalog rules left out. */
  warnings: string[];
}

/**
 * The app the gateway would serve for this listing: the remote catalog
 * normalized, hashed as the gateway's remote app hashes it, and taken
 * through the ToolBus's `normalizeCatalog` as the catalog sync takes the
 * contract's `tools/list` answer.
 */
async function remoteApp(
  appId: string,
  name: string,
  description: string,
  listing: UpstreamListing,
): Promise<RemoteApp> {
  const catalog = normalizeRemoteCatalog(appId, name, listing.tools, BLOCK);
  const instructions = listing.instructions?.slice(0, 2048);
  const hash = await catalogHash({
    ...(instructions ? { instructions } : {}),
    tools: catalog.tools,
  });
  const snapshot = normalizeCatalog(appId, {
    v: TOOLS_PROTOCOL_VERSION,
    sdk: `remote:${listing.era}`,
    hash,
    ...(instructions ? { instructions } : {}),
    tools: catalog.tools,
    ...(catalog.warnings.length > 0 ? { warnings: catalog.warnings } : {}),
  });
  if (snapshot.status !== "ok") {
    throw new Error(
      `${name}'s catalog did not normalize: ${"error" in snapshot ? snapshot.error : "no tools"}`,
    );
  }
  const rowId = `row_${appId}`;
  return {
    app: {
      rowId,
      appId,
      // A provider row's audience, as the gateway mints for it.
      audience: `provider:${rowId}`,
      name,
      description,
      baseUrl: `https://${appId}.harness.localhost`,
      catalogHash: snapshot.hash,
      ...(snapshot.instructions ? { instructions: snapshot.instructions } : {}),
      tools: snapshot.tools,
    },
    catalog,
    listing,
    warnings: snapshot.warnings,
  };
}

// ---------------------------------------------------------------------------
// The loopback ToolBus

/** A request the ToolBus answered, as the harness sees it. */
interface RecordedRequest {
  at: number;
  httpMethod: string;
  /** The JSON-RPC method in the body, else the Mcp-Method header. */
  method: string;
  /** tools/call: the tool the client named. */
  name?: string;
  protocol?: string;
  status: number;
  kind: "json" | "sse";
  authorized: boolean;
}

interface RecordedList {
  at: number;
  names: string[];
}

interface RecordedCall {
  at: number;
  name: string;
  arguments: unknown;
  isError: boolean;
  /** The first text block, cut. */
  text: string;
}

/** One contract call `invokeApp` answered. */
interface Invocation {
  at: number;
  /** The local name the ToolBus called. */
  name: string;
  /** The server's name it mapped to, if any. */
  upstream?: string;
  arguments: unknown;
  /** The verified identity's claims that bind it to this call. */
  identity?: { scopes: string[]; channel: string; toolCall?: unknown };
  /** Why the identity did not verify or bind, if it didn't. */
  refused?: string;
  outcome: string;
}

interface ToolBusHarness {
  url: string;
  requests: RecordedRequest[];
  lists: RecordedList[];
  calls: RecordedCall[];
  audits: ToolCallAuditEvent[];
  invocations: Invocation[];
  /** How often the ToolBus thought the app's catalog drifted. */
  drifts: number;
  /** Every answer the ToolBus sent Claude Code, for the leak checks. */
  answered: string[];
  streamsOpened: number;
  close(): Promise<void>;
}

function contractError(
  status: number,
  code: ToolsErrorCodeV1,
  message: string,
): Response {
  return Response.json(
    { v: TOOLS_PROTOCOL_VERSION, error: { code, message } },
    { status },
  );
}

async function startToolBus(
  remote: RemoteApp,
  client: RemoteMcpClient,
): Promise<ToolBusHarness> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const publicKeyPem = await exportSPKI(keys.publicKey);
  const requests: RecordedRequest[] = [];
  const lists: RecordedList[] = [];
  const calls: RecordedCall[] = [];
  const audits: ToolCallAuditEvent[] = [];
  const invocations: Invocation[] = [];
  const answered: string[] = [];
  const counters = { streamsOpened: 0, drifts: 0 };
  const { app, catalog } = remote;

  // The listing is the default for this principal and app (full: a few
  // tools); the refresh closure lets the modern era declare
  // `listChanged: true` and hold listen streams, as the gateway does.
  const currentView = (): ToolBusView => ({
    ...gatewaySurfaceView(PRINCIPAL, [app]),
    refresh: async () => currentView(),
  });

  const serve = createToolBusHttp({
    signing: {
      privateKeyPem: await exportPKCS8(keys.privateKey),
      issuer: ISSUER,
    },
    // The gateway's in-process remote app, cut to what a call needs.
    invokeApp: async (target, request) => {
      const at = Date.now();
      const body = (await request.json()) as Record<string, unknown>;
      const name = typeof body["name"] === "string" ? body["name"] : "?";
      const args = isRecord(body["arguments"]) ? body["arguments"] : {};
      const upstream = catalog.map.get(name);
      const invocation: Invocation = {
        at,
        name,
        ...(upstream ? { upstream } : {}),
        arguments: args,
        outcome: "?",
      };
      invocations.push(invocation);
      let user: EveryAppUser;
      try {
        user = await verifyIdentityJwt(
          request.headers.get(IDENTITY_HEADER) ?? "",
          {
            publicKeys: [publicKeyPem],
            audience: target.audience,
            issuer: ISSUER,
          },
        );
      } catch (error) {
        invocation.refused = String(error);
        invocation.outcome = "unauthenticated";
        return contractError(401, "unauthenticated", "identity refused");
      }
      invocation.identity = {
        scopes: user.scopes,
        channel: user.channel,
        ...(user.toolCall ? { toolCall: user.toolCall } : {}),
      };
      if (
        user.channel !== "mcp" ||
        user.toolCall?.name !== name ||
        user.toolCall.id !== body["callId"]
      ) {
        invocation.refused = "the identity was minted for another call";
        invocation.outcome = "forbidden";
        return contractError(
          403,
          "forbidden",
          "The identity was minted for a different tool call.",
        );
      }
      if (!upstream) {
        invocation.outcome = "unknown_tool";
        return contractError(404, "unknown_tool", `Unknown tool: ${name}`);
      }
      let result: ToolCallResultV1;
      try {
        const answer = await client.callTool(upstream, args, request.signal);
        result = {
          content: answer.content as ToolCallResultV1["content"],
          ...(answer.structuredContent
            ? { structuredContent: answer.structuredContent }
            : {}),
          ...(answer.isError ? { isError: true } : {}),
        };
        invocation.outcome = answer.isError ? "tool_error" : "ok";
      } catch (error) {
        const why =
          error instanceof RemoteMcpError
            ? error.message
            : "the server could not be reached";
        invocation.outcome = `upstream_failed: ${why}`;
        result = {
          content: [{ type: "text", text: `${target.name}: ${why}.` }],
          isError: true,
        };
      }
      return Response.json({
        v: TOOLS_PROTOCOL_VERSION,
        catalogHash: target.catalogHash,
        result,
      });
    },
    onCatalogDrift: () => {
      counters.drifts += 1;
    },
    audit: (event) => {
      audits.push(event);
    },
    digestArguments: createArgumentsDigester("harness-secret", "toolbus-args"),
    listenPollMs: 15_000,
    listenMaxMs: 5 * MINUTE,
  });

  const record = (
    request: Pick<RecordedRequest, "method" | "name">,
    args: unknown,
    text: string,
    sse: boolean,
  ) => {
    answered.push(text);
    const at = Date.now();
    for (const message of messagesIn(text, sse)) {
      if (!isRecord(message) || !isRecord(message["result"])) continue;
      const result = message["result"];
      if (request.method === "tools/list" && Array.isArray(result["tools"])) {
        lists.push({
          at,
          names: result["tools"].map((tool) =>
            String((tool as { name?: unknown }).name),
          ),
        });
      }
      if (request.method === "tools/call" && Array.isArray(result["content"])) {
        calls.push({
          at,
          name: request.name ?? "?",
          arguments: args,
          isError: result["isError"] === true,
          text: firstText(result),
        });
      }
    }
  };

  const decoder = new TextDecoder();
  const server = createServer((message, response) => {
    void (async () => {
      const at = Date.now();
      try {
        const { headers, bytes } = await readMessage(message);
        const request = new Request(
          `http://${message.headers.host ?? "localhost"}${message.url}`,
          {
            method: message.method,
            headers,
            ...(bytes.length > 0 ? { body: bytes } : {}),
          },
        );
        const body = parseJson(bytes.toString("utf8"));
        const authorized =
          request.headers.get("authorization") === `Bearer ${TOOLBUS_TOKEN}`;
        const params =
          isRecord(body) && isRecord(body["params"]) ? body["params"] : {};
        const method =
          isRecord(body) && typeof body["method"] === "string"
            ? body["method"]
            : (request.headers.get("mcp-method") ?? "?");
        const name =
          typeof params["name"] === "string" ? params["name"] : undefined;
        let reply: Response;
        if (new URL(request.url).pathname !== "/mcp") {
          reply = new Response("not found", { status: 404 });
        } else if (request.method === "POST" && !authorized) {
          reply = Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32001, message: "Unauthorized" },
              id: null,
            },
            {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="harness"' },
            },
          );
        } else {
          reply = await serve(request, currentView());
        }
        const sse = reply.headers.get("content-type") === "text/event-stream";
        requests.push({
          at,
          httpMethod: message.method ?? "?",
          method,
          ...(name ? { name } : {}),
          ...(request.headers.get("mcp-protocol-version")
            ? { protocol: request.headers.get("mcp-protocol-version")! }
            : {}),
          status: reply.status,
          kind: sse ? "sse" : "json",
          authorized,
        });
        response.writeHead(reply.status, Object.fromEntries(reply.headers));
        if (!sse || !reply.body) {
          const out = Buffer.from(await reply.arrayBuffer());
          record(
            { method, ...(name ? { name } : {}) },
            params["arguments"],
            out.toString("utf8"),
            false,
          );
          response.end(out);
          return;
        }
        if (method === "subscriptions/listen") counters.streamsOpened += 1;
        const reader = reply.body.getReader();
        // The client going away ends the held stream on the ToolBus too.
        response.on("close", () => {
          reader.cancel().catch(() => undefined);
        });
        let text = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (!response.destroyed) response.write(value);
          }
        } finally {
          record(
            { method, ...(name ? { name } : {}) },
            params["arguments"],
            text,
            true,
          );
          if (!response.destroyed) response.end();
        }
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(String(error));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    lists,
    calls,
    audits,
    invocations,
    answered,
    get drifts() {
      return counters.drifts;
    },
    get streamsOpened() {
      return counters.streamsOpened;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Claude Code

/** One tool call Claude made, as its stream reports it. */
interface ToolUse {
  name: string;
  input: unknown;
}

/** A `claude -p` session kept alive on a stream-json stdin. */
class ClaudeSession {
  readonly events: unknown[] = [];
  readonly log: string[] = [];
  readonly debugFile: string;
  exitCode: number | null = null;
  private child: ChildProcess;
  private exited: Promise<number | null>;

  constructor(mcpUrl: string, cwd: string) {
    this.debugFile = join(cwd, "claude-debug.log");
    this.child = spawn(
      "claude",
      [
        "-p",
        "--model",
        MODEL,
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--debug",
        "mcp",
        "--debug-file",
        this.debugFile,
        "--max-turns",
        "12",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            everyapp: {
              type: "http",
              url: mcpUrl,
              headers: { Authorization: `Bearer ${TOOLBUS_TOKEN}` },
            },
          },
        }),
        // No built-in tools: the MCP server's are the only ones it has.
        "--tools",
        "",
      ],
      {
        cwd,
        env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    this.child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const lines = out.split("\n");
      out = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        this.log.push(`${stamp()} stdout ${line.slice(0, 600)}`);
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // Not JSON: logged above.
        }
      }
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.trim())
          this.log.push(`${stamp()} stderr ${line.slice(0, 600)}`);
      }
    });
    this.exited = new Promise((resolve) =>
      this.child.on("exit", (code) => {
        this.exitCode = code;
        resolve(code);
      }),
    );
  }

  send(text: string): void {
    this.child.stdin?.write(
      `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`,
    );
  }

  /** The tool calls in Claude's assistant messages, in order. */
  toolUses(): ToolUse[] {
    const uses: ToolUse[] = [];
    for (const event of this.events) {
      if (!isRecord(event) || event["type"] !== "assistant") continue;
      const message = event["message"];
      const content = isRecord(message) ? message["content"] : undefined;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (isRecord(part) && part["type"] === "tool_use") {
          uses.push({ name: String(part["name"]), input: part["input"] });
        }
      }
    }
    return uses;
  }

  /** The turn ended: a `result` event arrived. */
  result(): Record<string, unknown> | undefined {
    return this.events.find(
      (event): event is Record<string, unknown> =>
        isRecord(event) && event["type"] === "result",
    );
  }

  /** Claude's final text: the result event's, else every assistant text. */
  finalText(): string {
    const result = this.result();
    if (result && typeof result["result"] === "string") return result["result"];
    return this.events
      .flatMap((event) => {
        if (!isRecord(event) || event["type"] !== "assistant") return [];
        const message = event["message"];
        const content = isRecord(message) ? message["content"] : undefined;
        return Array.isArray(content)
          ? content.flatMap((part) =>
              isRecord(part) && typeof part["text"] === "string"
                ? [part["text"]]
                : [],
            )
          : [];
      })
      .join("\n");
  }

  async close(): Promise<number | null> {
    this.child.stdin?.end();
    const code = await Promise.race([
      this.exited,
      sleep(20_000).then(() => null),
    ]);
    if (code === null && this.child.exitCode === null)
      this.child.kill("SIGTERM");
    return code;
  }
}

// ---------------------------------------------------------------------------
// One run and its report

let fake: FakeUpstream | undefined;
let toolbus: ToolBusHarness | undefined;
let session: ClaudeSession | undefined;

afterEach(async () => {
  await session?.close();
  await toolbus?.close();
  await fake?.close();
  session = undefined;
  toolbus = undefined;
  fake = undefined;
});

async function run(prompt: string, name: string): Promise<number> {
  const cwd = await mkdtemp(join(tmpdir(), `remote-mcp-${name}-`));
  session = new ClaudeSession(toolbus!.url, cwd);
  const startedAt = Date.now();
  session.send(prompt);
  await waitFor(
    "Claude's turn to end",
    () => session!.result() !== undefined,
    6 * MINUTE,
    () =>
      session!.exitCode !== null
        ? `claude exited with ${session!.exitCode}:\n${session!.log.join("\n")}`
        : null,
  );
  return startedAt;
}

/** How a request to the remote server was authorized, without the value. */
function credentialOf(headers: Record<string, string>): string {
  const auth = headers["authorization"];
  if (!auth) return "no credential";
  if (auth === `Bearer ${UPSTREAM_TOKEN}`) return "the server's bearer";
  if (auth.includes(TOOLBUS_TOKEN)) return "THE TOOLBUS BEARER";
  return "another credential";
}

function describeUpstream(
  requests: UpstreamRequest[],
  startedAt: number,
): string[] {
  return requests.map(
    (request) =>
      `${((request.at - startedAt) / 1000).toFixed(1).padStart(7)} s  ${request.method.padEnd(26)} ${(request.name ?? "").padEnd(14)} ${request.status} ${request.contentType.split(";")[0] || "-"} ${request.headers["mcp-protocol-version"] ?? "-"} ${credentialOf(request.headers)}${request.headers[IDENTITY_HEADER] ? " IDENTITY FORWARDED" : ""}${request.answer !== undefined ? ` -> ${JSON.stringify(request.answer.slice(0, 200))}` : ""}`,
  );
}

/** The whole run, in order, for the report. */
function describeRun(
  remote: RemoteApp,
  upstream: UpstreamRequest[],
  startedAt: number,
): string {
  const seconds = (at: number) =>
    `${((at - startedAt) / 1000).toFixed(1).padStart(7)} s`;
  const records = remote.catalog.records.map(
    (record) =>
      `${record.upstreamName} -> ${record.localName ? `${remote.app.appId}_${record.localName}` : "(no name)"}: hint ${record.riskHint}, risk ${record.risk ?? "-"} (${record.source ?? "-"}), ${record.listed ? "listed" : `not listed: ${record.problem}`}`,
  );
  const requests = toolbus!.requests.map(
    (request) =>
      `${seconds(request.at)}  ${request.httpMethod} ${request.method.padEnd(22)} ${(request.name ?? "").padEnd(32)} ${request.status} ${request.kind}${request.authorized ? "" : " UNAUTHORIZED"}${request.protocol ? ` (${request.protocol})` : ""}`,
  );
  const lists = toolbus!.lists.map(
    (list, index) =>
      `list ${index + 1} at ${seconds(list.at)}: ${list.names.length} tools: ${list.names.join(", ")}`,
  );
  const calls = toolbus!.calls.map(
    (call) =>
      `${seconds(call.at)}  ${call.name} ${JSON.stringify(call.arguments)} -> ${call.isError ? "ERROR " : ""}${JSON.stringify(call.text)}`,
  );
  const audits = toolbus!.audits.map((event) =>
    JSON.stringify({
      tool: event.tool,
      appId: event.appId,
      risk: event.risk,
      decision: event.decision,
      reason: event.reason,
      outcome: event.outcome,
      argsDigest: event.argsDigest,
      resultBytes: event.resultBytes,
      protocolVersion: event.protocolVersion,
      clientInfo: event.clientInfo,
    }),
  );
  const invocations = toolbus!.invocations.map(
    (invocation) =>
      `${seconds(invocation.at)}  ${invocation.name} -> ${invocation.upstream ?? "(unmapped)"} ${JSON.stringify(invocation.arguments)} scopes=${JSON.stringify(invocation.identity?.scopes)} chan=${JSON.stringify(invocation.identity?.channel)} tc=${JSON.stringify(invocation.identity?.toolCall)} outcome=${invocation.outcome}${invocation.refused ? ` refused: ${invocation.refused}` : ""}`,
  );
  const uses = session!
    .toolUses()
    .map((use) => `${use.name} ${JSON.stringify(use.input)}`);
  return [
    `## The remote server (${remote.listing.era} era${remote.listing.serverInfo?.name ? `, ${remote.listing.serverInfo.name}` : ""})`,
    ...records,
    ...(remote.warnings.length
      ? ["warnings:", ...remote.warnings.map((warning) => `  ${warning}`)]
      : []),
    "",
    "## Requests to the remote server",
    ...describeUpstream(upstream, startedAt),
    "",
    "## ToolBus requests",
    ...requests,
    `listen streams opened: ${toolbus!.streamsOpened}; catalog drifts: ${toolbus!.drifts}`,
    "",
    "## tools/list answers",
    ...lists,
    "",
    "## tools/call (as the client sent them, with the first text block of the answer)",
    ...calls,
    "",
    "## Audit events",
    ...audits,
    "",
    "## App invocations (the contract calls the remote app answered)",
    ...invocations,
    "",
    "## Claude's tool calls (its stream)",
    ...uses,
    "",
    "## Claude's final text",
    session!.finalText(),
  ].join("\n");
}

async function writeReport(name: string, text: string): Promise<string> {
  const dir = process.env["REMOTE_REPORT_DIR"] ?? tmpdir();
  const file = join(dir, `remote-mcp-${name}-${Date.now()}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, text);
  console.log(`report: ${file}`);
  return file;
}

async function report(
  name: string,
  remote: RemoteApp,
  upstream: UpstreamRequest[],
  startedAt: number,
  summary: string[] = [],
): Promise<string> {
  let debug = "";
  try {
    debug = await readFile(session!.debugFile, "utf8");
  } catch {
    debug = "(no debug log)";
  }
  const described = describeRun(remote, upstream, startedAt);
  const text = [
    `# remote-mcp ${name} (${new Date(startedAt).toISOString()}, model ${MODEL})`,
    "",
    ...summary,
    ...(summary.length ? [""] : []),
    described,
    "",
    "## Claude Code's MCP debug log (tool lines)",
    ...debug
      .split("\n")
      .filter((line) => /everyapp|tools\/list|tools\/call|listen/.test(line)),
    "",
    "## Claude Code's output",
    ...(session?.log ?? []),
  ].join("\n");
  await writeReport(name, text);
  console.log([...summary, described].join("\n"));
  return text;
}

/** The names the client called, from the ToolBus's requests. */
function calledNames(): string[] {
  return toolbus!.requests
    .filter((request) => request.method === "tools/call" && request.name)
    .map((request) => request.name!);
}

/** Everything Claude Code was sent or printed: where no credential may be. */
function seenByClaude(): string {
  return [...toolbus!.answered, ...session!.log].join("\n");
}

// ---------------------------------------------------------------------------
// The cases

describe("fake: a credentialed remote server through the ToolBus", () => {
  it(
    "Claude sees harbor's read and write tools, not the destructive one, calls harbor_lookup_port, and the server sees one call with its own bearer",
    async () => {
      fake = await startFakeUpstream();
      const sent: UpstreamRequest[] = [];
      const client = new RemoteMcpClient({
        url: fake.url,
        // The gateway's path from the registration to the headers.
        headers: remoteMcpAuthHeaders(
          { kind: "bearer", secret: "HARBOR_MCP_TOKEN" },
          UPSTREAM_TOKEN,
        ),
        fetch: recordingFetch(sent),
      });
      const remote = await remoteApp(
        HARBOR_ID,
        HARBOR_NAME,
        "The harbor office's MCP server, served through this Gateway.",
        await client.listTools(),
      );
      toolbus = await startToolBus(remote, client);
      const startedAt = await run(FAKE_PROMPT, "fake");
      const text = await report("fake", remote, fake.requests, startedAt);

      // The normalization: camelCase upstream names, risks from the hints.
      expect(
        remote.catalog.records.map((record) => [
          record.upstreamName,
          record.localName,
          record.risk,
          record.listed,
        ]),
      ).toEqual([
        ["lookupPort", "lookup_port", "read", true],
        ["scuttle", "scuttle", "destructive", true],
        ["setBerth", "set_berth", "write", true],
      ]);
      expect(remote.listing.era).toBe(MODERN);

      // tools/list to Claude: read and write listed, destructive hidden.
      expect(toolbus.lists.length).toBeGreaterThanOrEqual(1);
      for (const list of toolbus.lists) {
        expect(list.names).toContain("harbor_lookup_port");
        expect(list.names).toContain("harbor_set_berth");
        expect(list.names).not.toContain("harbor_scuttle");
      }
      expect(toolbus.requests.some((request) => !request.authorized)).toBe(
        false,
      );

      // Claude called the read tool, and nothing else of harbor's.
      expect(calledNames()).toContain("harbor_lookup_port");
      expect(
        calledNames().filter((name) => name.startsWith(`${HARBOR_ID}_`)),
      ).toEqual(["harbor_lookup_port"]);

      // The fake saw the listing and exactly one call, under the server's
      // own name, each with its own bearer, in the 2026-07-28 era, and
      // never the ToolBus's bearer or the member's identity.
      const upstreamCalls = fake.requests.filter(
        (request) => request.method === "tools/call",
      );
      expect(upstreamCalls).toHaveLength(1);
      expect(upstreamCalls[0]!.name).toBe("lookupPort");
      expect(upstreamCalls[0]!.headers["mcp-name"]).toBe("lookupPort");
      expect(upstreamCalls[0]!.status).toBe(200);
      expect(upstreamCalls[0]!.answer).toContain(ANSWER_MARKER);
      expect(fake.requests.map((request) => request.method)).toEqual([
        "tools/list",
        "tools/call",
      ]);
      for (const request of fake.requests) {
        expect(request.headers["authorization"]).toBe(
          `Bearer ${UPSTREAM_TOKEN}`,
        );
        expect(request.headers["mcp-protocol-version"]).toBe(MODERN);
        expect(request.headers[IDENTITY_HEADER]).toBeUndefined();
        expect(headerValues(request.headers)).not.toContain(TOOLBUS_TOKEN);
        expect(JSON.stringify(request.body)).not.toContain(TOOLBUS_TOKEN);
      }
      expect(sent).toHaveLength(fake.requests.length);

      // One audit row for harbor: the read tool, allowed, ok.
      const rows = toolbus.audits.filter((event) => event.appId === HARBOR_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tool: "harbor_lookup_port",
        risk: "read",
        decision: "allowed",
        outcome: "ok",
      });

      // The contract call: one, mapped, under an identity minted for it.
      expect(toolbus.invocations).toHaveLength(1);
      expect(toolbus.invocations[0]).toMatchObject({
        name: "lookup_port",
        upstream: "lookupPort",
        outcome: "ok",
      });
      expect(toolbus.invocations[0]!.identity?.channel).toBe("mcp");
      expect(toolbus.invocations[0]!.identity?.scopes).toContain("mcp:read");
      expect(toolbus.drifts).toBe(0);

      // The server's credential never reached Claude Code.
      expect(seenByClaude()).not.toContain(UPSTREAM_TOKEN);
      expect(text).not.toContain(UPSTREAM_TOKEN);

      expect(session!.finalText()).toContain(ANSWER_MARKER);
    },
    8 * MINUTE,
  );
});

/** The first live candidate whose `tools/list` answers, or why none did. */
async function firstReachable(): Promise<
  | {
      ok: true;
      candidate: LiveCandidate;
      client: RemoteMcpClient;
      listing: UpstreamListing;
      sent: UpstreamRequest[];
      tried: string[];
    }
  | { ok: false; tried: string[] }
> {
  const tried: string[] = [];
  const only = process.env["REMOTE_LIVE"];
  for (const candidate of LIVE_CANDIDATES) {
    if (only && candidate.appId !== only) continue;
    const sent: UpstreamRequest[] = [];
    const client = new RemoteMcpClient({
      url: candidate.url,
      fetch: recordingFetch(sent),
      listTimeoutMs: 15_000,
    });
    const started = Date.now();
    try {
      const listing = await client.listTools();
      tried.push(
        `${candidate.url}: answered in ${Date.now() - started} ms (${listing.era} era, ${listing.tools.length} tools)`,
      );
      if (listing.tools.length === 0) continue;
      return { ok: true, candidate, client, listing, sent, tried };
    } catch (error) {
      tried.push(
        `${candidate.url}: ${error instanceof RemoteMcpError ? `${error.kind}: ${error.message}` : String(error)}`,
      );
    }
  }
  if (tried.length === 0) tried.push(`REMOTE_LIVE=${only} names no candidate`);
  return { ok: false, tried };
}

describe("live: a public no-auth MCP server through the ToolBus", () => {
  it(
    "Claude calls one of the server's tools through the ToolBus and answers",
    async (context) => {
      const found = await firstReachable();
      if (!found.ok) {
        const reason = `no public MCP server answered tools/list within 15 s: ${found.tried.join("; ")}`;
        await writeReport(
          "live",
          [`# remote-mcp live: SKIPPED`, "", reason].join("\n"),
        );
        console.log(`live: skipped: ${reason}`);
        return context.skip(reason);
      }
      const { candidate, client, listing, sent, tried } = found;
      const remote = await remoteApp(
        candidate.appId,
        candidate.name,
        candidate.description,
        listing,
      );
      toolbus = await startToolBus(remote, client);
      const startedAt = await run(candidate.prompt, "live");
      const prefix = `${candidate.appId}_`;
      const called = calledNames().filter((name) => name.startsWith(prefix));
      const upstreamCalls = sent.filter(
        (request) => request.method === "tools/call",
      );
      const answer = session!.finalText();
      const summary = [
        "## Summary",
        `server: ${candidate.name} ${candidate.url} (${listing.era} era)`,
        ...tried.map((line) => `probe: ${line}`),
        `upstream tools: ${listing.tools.map((tool) => tool.name).join(", ")}`,
        `listed to Claude: ${(toolbus.lists[0]?.names ?? []).filter((name) => name.startsWith(prefix)).join(", ")}`,
        `Claude called: ${called.join(", ") || "(nothing of the server's)"}`,
        `the server answered: ${JSON.stringify((upstreamCalls[0]?.answer ?? "").slice(0, 200))}`,
        `Claude's answer: ${JSON.stringify(answer.slice(0, 200))}`,
      ];
      await report("live", remote, sent, startedAt, summary);

      expect(toolbus.lists.length).toBeGreaterThanOrEqual(1);
      for (const list of toolbus.lists) {
        expect(list.names.some((name) => name.startsWith(prefix))).toBe(true);
      }
      expect(toolbus.requests.some((request) => !request.authorized)).toBe(
        false,
      );
      // Claude called one of the server's tools through the ToolBus, the
      // remote app mapped it, and the server answered it.
      expect(called.length).toBeGreaterThanOrEqual(1);
      expect(
        toolbus.invocations.some(
          (invocation) =>
            invocation.upstream !== undefined && invocation.outcome === "ok",
        ),
      ).toBe(true);
      expect(
        toolbus.audits.some(
          (event) =>
            event.appId === candidate.appId &&
            event.decision === "allowed" &&
            event.outcome === "ok",
        ),
      ).toBe(true);
      expect(upstreamCalls.length).toBeGreaterThanOrEqual(1);
      // Nothing of the caller's went upstream: no credential at all (auth
      // none), never the ToolBus's bearer, never the member's identity.
      for (const request of sent) {
        expect(request.headers["authorization"]).toBeUndefined();
        expect(request.headers[IDENTITY_HEADER]).toBeUndefined();
        expect(headerValues(request.headers)).not.toContain(TOOLBUS_TOKEN);
      }
      expect(answer.trim().length).toBeGreaterThan(20);
    },
    8 * MINUTE,
  );
});
