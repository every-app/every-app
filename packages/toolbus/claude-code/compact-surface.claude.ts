/**
 * Claude Code against the gateway surface's compact listing, with a real
 * `claude -p` (needs the `claude` CLI logged in; spends a few cents; not run
 * in CI). It answers one question: does a client that is shown only the
 * built-ins find an app's tool with `everyapp_search_tools`, run it through
 * `everyapp_call_read`, and read the answer, with the ToolBus auditing the
 * inner tool once (`via` the wrapper) and invoking the app once?
 *
 * The loopback ToolBus here is the real HTTP layer over a fake app of a
 * few read and write tools (and one destructive tool, which policy hides)
 * whose `list_todos` answers a fixed JSON board. Every request, every
 * `tools/list` answer, every `tools/call`, every audit event and every app
 * invocation is recorded, and the report at the end lists them in order.
 *
 * Two cases, each with its own server, port and Claude Code session:
 *
 *   compact  the view's listing set to "compact": tools/list shows the five
 *            built-ins and no app tool; Claude must search, then call
 *            through the read wrapper.
 *   full     the same board listed in full: Claude calls the app's tool by
 *            its own name, and the audit row has no `via`.
 *
 *   pnpm -C packages/toolbus test:claude-code compact-surface
 *   COMPACT_MODEL=opus pnpm -C packages/toolbus test:claude-code compact-surface
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IDENTITY_HEADER,
  TOOLS_PROTOCOL_VERSION,
} from "@every-app/sdk/internal";
import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createArgumentsDigester } from "../src/digest";
import { createToolBusHttp } from "../src/http";
import type {
  McpPrincipal,
  ToolBusApp,
  ToolBusView,
  ToolCallAuditEvent,
} from "../src/types";
import { gatewaySurfaceView } from "../src/view";

const MODEL = process.env["COMPACT_MODEL"] ?? "sonnet";
const MINUTE = 60_000;
const ISSUER = "https://gateway.harness.localhost";
/** The bearer Claude Code must send; the server answers 401 without it. */
const TOKEN = `harness-${crypto.randomUUID()}`;

const PRINCIPAL: McpPrincipal = {
  userId: "user_harness",
  email: "harness@example.com",
  organizationId: "org_harness",
  organizationName: "Harness",
  orgRole: "owner",
  credential: { kind: "pat", id: "pat_harness" },
  access: "write",
};

const APP_ID = "quay";
const CATALOG_HASH = `sha256:${"q".repeat(64)}`;
/** What `list_todos` answers, whatever the arguments. */
const BOARD = {
  todos: [
    { id: "td_1", title: "Renew the harbor permit", done: false },
    { id: "td_2", title: "Order new mooring lines", done: true },
  ],
  total: 2,
};
/** The part of the fixed answer Claude's final text must carry. */
const ANSWER_MARKER = "Renew the harbor permit";
const INNER_TOOL = `${APP_ID}_list_todos`;
const PROMPT =
  "Find the tool on the everyapp MCP server that lists todos, call it, and report exactly what it returned: quote the JSON as it came back.";

const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

function quayApp(): ToolBusApp {
  return {
    rowId: "row_quay",
    appId: APP_ID,
    audience: "every-harness-quay",
    name: "Quay Board",
    description: "The harbor crew's todo board.",
    baseUrl: "https://quay.harness.localhost",
    catalogHash: CATALOG_HASH,
    instructions: "Read the board before changing it.",
    tools: [
      {
        name: "list_todos",
        title: "List todos",
        description:
          "List every todo on the board, open and done, with its id.",
        risk: "read",
        inputSchema: objectSchema(),
      },
      {
        name: "get_todo",
        description: "One todo by id.",
        risk: "read",
        inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      },
      {
        name: "add_todo",
        title: "Add todo",
        description: "Add a todo to the board.",
        risk: "write",
        inputSchema: objectSchema({ title: { type: "string", minLength: 1 } }, [
          "title",
        ]),
      },
      {
        name: "finish_todo",
        description: "Mark a todo done.",
        risk: "write",
        inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      },
      {
        name: "remove_todo",
        description: "Remove a todo from the board.",
        risk: "destructive",
        inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
      },
    ],
  };
}

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

/** The payload of a JWT, unverified: this is the fake app reading its own header. */
function jwtPayload(token: string | null): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(
      Buffer.from(
        part.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A request the server answered, as the harness sees it. */
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
  /** For everyapp_search_tools: the names it returned. */
  found?: string[];
}

interface Invocation {
  at: number;
  name: string;
  arguments: unknown;
  /** Claims of the identity minted for this one call. */
  identity: Record<string, unknown> | null;
}

interface Harness {
  url: string;
  requests: RecordedRequest[];
  lists: RecordedList[];
  calls: RecordedCall[];
  audits: ToolCallAuditEvent[];
  invocations: Invocation[];
  streamsOpened: number;
  close(): Promise<void>;
}

async function toRequest(
  message: IncomingMessage,
): Promise<{ request: Request; body: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      headers.append(name, item);
    }
  }
  const bytes = Buffer.concat(chunks);
  let body: unknown;
  try {
    body = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
  } catch {
    body = undefined;
  }
  return {
    request: new Request(
      `http://${message.headers.host ?? "localhost"}${message.url}`,
      {
        method: message.method,
        headers,
        ...(bytes.length > 0 ? { body: bytes } : {}),
      },
    ),
    body,
  };
}

/** The JSON-RPC messages in a JSON body or an SSE text. */
function messagesIn(text: string, sse: boolean): unknown[] {
  const raw = sse
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
    : [text];
  const messages: unknown[] = [];
  for (const item of raw) {
    try {
      messages.push(JSON.parse(item));
    } catch {
      // A keepalive or a partial frame: nothing to record.
    }
  }
  return messages;
}

async function startHarness(listing: "full" | "compact"): Promise<Harness> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const requests: RecordedRequest[] = [];
  const lists: RecordedList[] = [];
  const calls: RecordedCall[] = [];
  const audits: ToolCallAuditEvent[] = [];
  const invocations: Invocation[] = [];
  const app = quayApp();
  const counters = { streamsOpened: 0 };

  // The listing is the caller's explicit choice here, as the gateway would
  // pass it from `X-EveryApp-Tools`; the refresh closure keeps it, so the
  // modern era declares `listChanged: true` and holds listen streams.
  const currentView = (): ToolBusView => ({
    ...gatewaySurfaceView(PRINCIPAL, [app], { listing }),
    refresh: async () => currentView(),
  });

  const serve = createToolBusHttp({
    signing: {
      privateKeyPem: await exportPKCS8(keys.privateKey),
      issuer: ISSUER,
    },
    invokeApp: async (_app, request) => {
      const body = (await request.json()) as {
        name: string;
        arguments: unknown;
      };
      invocations.push({
        at: Date.now(),
        name: body.name,
        arguments: body.arguments,
        identity: jwtPayload(request.headers.get(IDENTITY_HEADER)),
      });
      const result =
        body.name === "list_todos"
          ? {
              content: [{ type: "text", text: JSON.stringify(BOARD) }],
              structuredContent: BOARD,
            }
          : { content: [{ type: "text", text: `ran ${body.name}` }] };
      return Response.json({
        v: TOOLS_PROTOCOL_VERSION,
        catalogHash: CATALOG_HASH,
        result,
      });
    },
    audit: (event) => {
      audits.push(event);
    },
    // One key for both cases, so a wrapped and a direct call of the same
    // tool with the same arguments can be compared by digest.
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
        const first = result["content"].find(
          (block) => isRecord(block) && block["type"] === "text",
        ) as { text?: string } | undefined;
        const structured = result["structuredContent"];
        const found =
          isRecord(structured) && Array.isArray(structured["tools"])
            ? structured["tools"].map((tool) =>
                String((tool as { name?: unknown }).name),
              )
            : undefined;
        calls.push({
          at,
          name: request.name ?? "?",
          arguments: args,
          isError: result["isError"] === true,
          text: (first?.text ?? "").slice(0, 300),
          ...(found ? { found } : {}),
        });
      }
    }
  };

  const decoder = new TextDecoder();
  const server = createServer((message, response) => {
    void (async () => {
      const at = Date.now();
      try {
        const { request, body } = await toRequest(message);
        const authorized =
          request.headers.get("authorization") === `Bearer ${TOKEN}`;
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
          const bytes = Buffer.from(await reply.arrayBuffer());
          record(
            { method, ...(name ? { name } : {}) },
            params["arguments"],
            bytes.toString("utf8"),
            false,
          );
          response.end(bytes);
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
    requests,
    lists,
    calls,
    audits,
    invocations,
    get streamsOpened() {
      return counters.streamsOpened;
    },
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One tool call Claude made, as its stream reports it. */
interface ToolUse {
  at: number;
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
              headers: { Authorization: `Bearer ${TOKEN}` },
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
          uses.push({
            at: Date.now(),
            name: String(part["name"]),
            input: part["input"],
          });
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

let harness: Harness | undefined;
let session: ClaudeSession | undefined;

afterEach(async () => {
  await session?.close();
  await harness?.close();
  session = undefined;
  harness = undefined;
});

/** The whole run, in order, for the report and the structured result. */
function describeRun(startedAt: number): string {
  const seconds = (at: number) =>
    `${((at - startedAt) / 1000).toFixed(1).padStart(7)} s`;
  const requests = harness!.requests.map(
    (request) =>
      `${seconds(request.at)}  ${request.httpMethod} ${request.method.padEnd(22)} ${(request.name ?? "").padEnd(26)} ${request.status} ${request.kind}${request.authorized ? "" : " UNAUTHORIZED"}${request.protocol ? ` (${request.protocol})` : ""}`,
  );
  const lists = harness!.lists.map(
    (list, index) =>
      `list ${index + 1} at ${seconds(list.at)}: ${list.names.length} tools: ${list.names.join(", ")}`,
  );
  const calls = harness!.calls.map(
    (call) =>
      `${seconds(call.at)}  ${call.name} ${JSON.stringify(call.arguments)} -> ${call.isError ? "ERROR " : ""}${call.found ? `found [${call.found.join(", ")}] ` : ""}${JSON.stringify(call.text)}`,
  );
  const audits = harness!.audits.map((event) =>
    JSON.stringify({
      tool: event.tool,
      via: event.via,
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
  const invocations = harness!.invocations.map(
    (invocation) =>
      `${seconds(invocation.at)}  ${invocation.name} ${JSON.stringify(invocation.arguments)} scopes=${JSON.stringify(invocation.identity?.["scopes"])} tc=${JSON.stringify(invocation.identity?.["tc"])} chan=${JSON.stringify(invocation.identity?.["chan"])}`,
  );
  const uses = session!
    .toolUses()
    .map((use) => `${use.name} ${JSON.stringify(use.input)}`);
  return [
    "## ToolBus requests",
    ...requests,
    `listen streams opened: ${harness!.streamsOpened}`,
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
    "## App invocations",
    ...invocations,
    "",
    "## Claude's tool calls (its stream)",
    ...uses,
    "",
    "## Claude's final text",
    session!.finalText(),
  ].join("\n");
}

async function report(name: string, startedAt: number): Promise<string> {
  let debug = "";
  try {
    debug = await readFile(session!.debugFile, "utf8");
  } catch {
    debug = "(no debug log)";
  }
  const text = [
    `# compact-surface ${name} (${new Date(startedAt).toISOString()}, model ${MODEL})`,
    "",
    describeRun(startedAt),
    "",
    "## Claude Code's MCP debug log (tool lines)",
    ...debug
      .split("\n")
      .filter((line) => /everyapp|tools\/list|tools\/call|listen/.test(line)),
    "",
    "## Claude Code's output",
    ...(session?.log ?? []),
  ].join("\n");
  const dir = process.env["COMPACT_REPORT_DIR"] ?? tmpdir();
  const file = join(dir, `compact-surface-${name}-${startedAt}.log`);
  await mkdir(dir, { recursive: true });
  await writeFile(file, text);
  console.log(`report: ${file}`);
  console.log(describeRun(startedAt));
  return text;
}

async function run(listing: "full" | "compact"): Promise<number> {
  harness = await startHarness(listing);
  const cwd = await mkdtemp(join(tmpdir(), `compact-surface-${listing}-`));
  session = new ClaudeSession(harness.url, cwd);
  const startedAt = Date.now();
  session.send(PROMPT);
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

/** The names the client called, from the requests. */
function calledNames(): string[] {
  return harness!.requests
    .filter((request) => request.method === "tools/call" && request.name)
    .map((request) => request.name!);
}

/** The audit rows naming the inner tool, with and without a wrapper. */
function innerRows(): ToolCallAuditEvent[] {
  return harness!.audits.filter((event) => event.tool === INNER_TOOL);
}

const digests: Partial<Record<"compact" | "full", string>> = {};

describe("compact: only the built-ins are listed", () => {
  it(
    "Claude searches, calls through everyapp_call_read, and reads the board",
    async () => {
      const startedAt = await run("compact");
      const text = await report("compact", startedAt);

      // tools/list showed only the built-ins, never an app tool.
      expect(harness!.lists.length).toBeGreaterThanOrEqual(1);
      for (const list of harness!.lists) {
        expect(list.names.every((name) => name.startsWith("everyapp_"))).toBe(
          true,
        );
        expect(list.names).toContain("everyapp_search_tools");
        expect(list.names).toContain("everyapp_call_read");
        expect(list.names).toContain("everyapp_call_write");
        expect(list.names.some((name) => name.startsWith(`${APP_ID}_`))).toBe(
          false,
        );
      }
      expect(harness!.requests.some((request) => !request.authorized)).toBe(
        false,
      );
      // It searched, then called through the read wrapper.
      expect(calledNames()).toContain("everyapp_search_tools");
      expect(calledNames()).toContain("everyapp_call_read");
      // One audit row names the inner tool, via the wrapper.
      const rows = innerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.via).toBe("everyapp_call_read");
      expect(rows[0]!.outcome).toBe("ok");
      digests["compact"] = rows[0]!.argsDigest;
      // The app ran once, under a read-only identity.
      expect(harness!.invocations).toHaveLength(1);
      expect(harness!.invocations[0]!.name).toBe("list_todos");
      expect(harness!.invocations[0]!.identity?.["scopes"]).toEqual([
        "mcp:read",
      ]);
      expect(session!.finalText()).toContain(ANSWER_MARKER);
      expect(text).toContain(ANSWER_MARKER);
    },
    8 * MINUTE,
  );
});

describe("full: the app's tools are listed under their own names", () => {
  it(
    "Claude calls quay_list_todos itself, and the audit row has no via",
    async () => {
      const startedAt = await run("full");
      const text = await report("full", startedAt);

      expect(harness!.lists.length).toBeGreaterThanOrEqual(1);
      for (const list of harness!.lists) {
        expect(list.names).toContain(INNER_TOOL);
        expect(list.names).toContain("everyapp_search_tools");
        // The wrappers are callable but listed only in compact mode.
        expect(list.names).not.toContain("everyapp_call_read");
        expect(list.names).not.toContain("everyapp_call_write");
        // Destructive stays hidden.
        expect(list.names).not.toContain(`${APP_ID}_remove_todo`);
      }
      expect(harness!.requests.some((request) => !request.authorized)).toBe(
        false,
      );
      expect(calledNames()).toContain(INNER_TOOL);
      const rows = innerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.via).toBeUndefined();
      expect(rows[0]!.outcome).toBe("ok");
      digests["full"] = rows[0]!.argsDigest;
      // The same call made through the wrapper and directly: one digest.
      if (digests["compact"] && digests["full"]) {
        expect(digests["full"]).toBe(digests["compact"]);
      }
      expect(harness!.invocations).toHaveLength(1);
      expect(harness!.invocations[0]!.name).toBe("list_todos");
      expect(session!.finalText()).toContain(ANSWER_MARKER);
      expect(text).toContain(ANSWER_MARKER);
    },
    8 * MINUTE,
  );
});
