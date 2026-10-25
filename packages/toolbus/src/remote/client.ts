/**
 * A Streamable HTTP client for one remote MCP server, as the gateway uses
 * it to serve a remote MCP app (docs/design/2026-10-mcp-by-url.md, "The
 * client"). Dependency-free and pure (no `cloudflare:workers`), so the
 * gateway, the unit tests and the `claude -p` harness share it.
 *
 * What it does, and only this:
 *
 *  - `POST` to the one registered URL, with the credential headers it was
 *    given on every request and nothing else of the caller's, a JSON body
 *    per request, `Accept: application/json, text/event-stream`, and
 *    `redirect: "manual"`: a 3xx is a failure, the credential never
 *    follows a redirect anywhere.
 *  - Speaks the 2026-07-28 era first, as the ToolBus itself serves it
 *    (per-request `Mcp-Method`/`Mcp-Name` headers and `_meta` with the
 *    protocol version and the client's description; no session). When the
 *    server refuses that (an HTTP 4xx other than 401/403, or a JSON-RPC
 *    error that says the method or the version is unknown), it falls back
 *    to the 2025 era: `initialize` asking 2025-11-25 and taking what the
 *    server answers, `notifications/initialized`, the `Mcp-Session-Id`
 *    kept and sent on every later request, one re-initialize on a 404.
 *    The era and session are remembered for the client's life.
 *  - Reads JSON and SSE answers: an SSE stream is read frame by frame
 *    until the message with the request's id arrives; notifications in
 *    between are dropped, and a server-to-client request (sampling,
 *    elicitation, roots: nothing this client does) gets a JSON-RPC
 *    "method not found" back and the call fails.
 *  - Bounds everything: a deadline and a byte cap per request, `nextCursor`
 *    followed at most `MAX_LIST_PAGES` times.
 *  - Never puts the credential, the request headers or the server's body
 *    verbatim in an error: {@link RemoteMcpError} carries a kind, the
 *    status, a JSON-RPC code and at most 200 characters of the body with
 *    anything that looks like the credential removed.
 */
import {
  isPlainObject,
  readTextCapped,
  TimeoutError,
  withTimeout,
} from "../io";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
/** The 2025 version asked for; the server may answer an earlier one. */
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const LEGACY_VERSIONS_ACCEPTED = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

/** How long one `tools/list` page may take, and how much it may be. */
export const LIST_TIMEOUT_MS = 15_000;
const LIST_MAX_BYTES = 5 * 1024 * 1024;
/** `nextCursor` is followed at most this many times. */
export const MAX_LIST_PAGES = 20;
/** The default for one call: 25 of the ToolBus's 30 s, and the answer cap `call.ts` uses. */
export const CALL_TIMEOUT_MS = 25_000;
export const CALL_MAX_BYTES = 768 * 1024;
/** How much of an upstream body an error keeps, after sanitizing. */
const ERROR_HEAD_CHARS = 200;

const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

export type RemoteMcpErrorKind =
  /** A 3xx: the gateway follows no redirects. */
  | "redirect"
  /** 401: the server rejected the credential (or wants one). */
  | "unauthorized"
  /** 403. */
  | "forbidden"
  /** Any other HTTP failure. */
  | "http"
  /** A JSON-RPC error the server answered. */
  | "rpc"
  | "timeout"
  | "unreachable"
  | "too_large"
  /** The answer wasn't MCP, or asked for something this client doesn't do. */
  | "protocol";

export class RemoteMcpError extends Error {
  readonly kind: RemoteMcpErrorKind;
  readonly status?: number;
  readonly code?: number;
  /** A sanitized head of the server's body or message, for the log. */
  readonly head?: string;
  /** For `unauthorized`: the `WWW-Authenticate` challenge names an OAuth resource. */
  readonly wantsOAuth?: boolean;

  constructor(
    kind: RemoteMcpErrorKind,
    message: string,
    extra: {
      status?: number;
      code?: number;
      head?: string;
      wantsOAuth?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "RemoteMcpError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.head !== undefined) this.head = extra.head;
    if (extra.wantsOAuth !== undefined) this.wantsOAuth = extra.wantsOAuth;
  }
}

/** One tool as the server lists it, trusted for nothing yet. */
export interface UpstreamTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

export interface UpstreamListing {
  tools: UpstreamTool[];
  /** The server's instructions from the handshake, if any. */
  instructions?: string;
  serverInfo?: { name?: string; version?: string };
  era: "2026-07-28" | "2025";
  /** The 2026-07-28 `ttlMs` on the listing, if the server sent one. */
  ttlMs?: number;
  /** The listing was cut at the page cap. */
  truncated: boolean;
}

export interface UpstreamCallResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface RemoteMcpClientOptions {
  /** The registered URL: the only address ever fetched. */
  url: string;
  /** The credential headers ({@link remoteMcpAuthHeaders}); sent on every request, logged nowhere. */
  headers?: Record<string, string>;
  /**
   * Every form of the credential that must never appear in an error: the
   * raw value, its parts (a Basic user and password), its base64. The
   * header values are added by the client itself.
   */
  secrets?: string[];
  /** How this gateway introduces itself. */
  clientInfo?: { name: string; version: string };
  /** `fetch` to use (tests). Defaults to the global. */
  fetch?: typeof fetch;
  listTimeoutMs?: number;
  callTimeoutMs?: number;
  callMaxBytes?: number;
}

const DEFAULT_CLIENT_INFO = { name: "every-app-gateway", version: "0.1" };

interface JsonRpcResponse {
  id: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

type Era =
  | { kind: "modern" }
  | { kind: "legacy"; version: string; sessionId: string | null };

/** The shortest credential fragment the sanitizer removes by value. */
const SECRET_MIN_CHARS = 3;
/** Printable text, bounded: for anything the server chose that ends up in a message. */
function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const printable = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return printable.length > max ? `${printable.slice(0, max - 1)}…` : printable;
}

/**
 * Strip anything that looks like the credential (its value, every form the
 * caller named, and any Bearer or Basic token), then cut. The value is
 * removed before whitespace is folded, so a value with a tab or newline in
 * it still matches itself.
 */
function sanitizedHead(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= SECRET_MIN_CHARS)
      out = out.split(secret).join("[credential]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [credential]");
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [credential]");
  return cleanText(out, ERROR_HEAD_CHARS);
}

/** The JSON-RPC messages in an SSE text (`data:` lines), parsed. */
function sseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const frame of text.replace(/\r\n|\r/g, "\n").split(/\n\n+/)) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      // A keepalive or a partial frame: nothing to read.
    }
  }
  return messages;
}

function isResponseTo(
  message: unknown,
  id: number,
): message is JsonRpcResponse {
  return (
    isPlainObject(message) &&
    message["id"] === id &&
    ("result" in message || "error" in message)
  );
}

/** A server-to-client request (sampling, elicitation, roots): not done here. */
function isServerRequest(
  message: unknown,
): message is { id: unknown; method: string } {
  return (
    isPlainObject(message) &&
    typeof message["method"] === "string" &&
    "id" in message
  );
}

export class RemoteMcpClient {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly secrets: string[];
  private readonly clientInfo: { name: string; version: string };
  private readonly fetchImpl: typeof fetch;
  private readonly listTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly callMaxBytes: number;
  private era: Era | undefined;
  private instructions: string | undefined;
  private serverInfo: { name?: string; version?: string } | undefined;
  private nextId = 1;

  constructor(options: RemoteMcpClientOptions) {
    this.url = options.url;
    this.headers = { ...(options.headers ?? {}) };
    // What must never appear in an error: each credential header's value,
    // the bare token behind a Bearer or Basic prefix, and every form the
    // caller named (the raw value, its parts, its base64); longest first,
    // so a part never breaks the whole before the whole is removed.
    const forms = new Set<string>();
    for (const value of Object.values(this.headers)) {
      forms.add(value);
      const bare = value.replace(/^(Bearer|Basic)\s+/i, "");
      if (bare !== value) forms.add(bare);
    }
    for (const secret of options.secrets ?? []) {
      if (!secret) continue;
      forms.add(secret);
      try {
        forms.add(encodeURIComponent(secret));
      } catch {
        // Not encodable: nothing more to strip.
      }
    }
    this.secrets = [...forms]
      .filter((form) => form.length >= SECRET_MIN_CHARS)
      .sort((a, b) => b.length - a.length);
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.fetchImpl = options.fetch ?? fetch;
    this.listTimeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.callMaxBytes = options.callMaxBytes ?? CALL_MAX_BYTES;
  }

  /** The era the server turned out to speak, once known. */
  get negotiated(): "2026-07-28" | "2025" | undefined {
    return this.era?.kind === "modern"
      ? "2026-07-28"
      : this.era
        ? "2025"
        : undefined;
  }

  /** Forget the era and session (a changed registration). */
  reset(): void {
    this.era = undefined;
    this.instructions = undefined;
    this.serverInfo = undefined;
  }

  /** The server's tools, every page, with its instructions and era. */
  async listTools(signal?: AbortSignal): Promise<UpstreamListing> {
    const tools: UpstreamTool[] = [];
    let cursor: string | undefined;
    let truncated = false;
    let ttlMs: number | undefined;
    // One deadline and one byte budget for the whole listing, every page
    // included, so a server with many pages can't take 20 times either.
    const deadlineAt = Date.now() + this.listTimeoutMs;
    let bytesLeft = LIST_MAX_BYTES;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_LIST_PAGES) {
        truncated = true;
        break;
      }
      const { result, bytes } = await this.requestCounted(
        "tools/list",
        cursor ? { cursor } : {},
        {
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          maxBytes: bytesLeft,
          signal,
        },
      );
      bytesLeft = Math.max(1, bytesLeft - bytes);
      if (!isPlainObject(result) || !Array.isArray(result["tools"])) {
        throw new RemoteMcpError(
          "protocol",
          "the server's tools/list answer has no tools list",
        );
      }
      for (const raw of result["tools"]) {
        if (!isPlainObject(raw) || typeof raw["name"] !== "string") continue;
        tools.push({
          name: raw["name"],
          ...(typeof raw["title"] === "string" ? { title: raw["title"] } : {}),
          ...(typeof raw["description"] === "string"
            ? { description: raw["description"] }
            : {}),
          ...(raw["inputSchema"] !== undefined
            ? { inputSchema: raw["inputSchema"] }
            : {}),
          ...(raw["outputSchema"] !== undefined
            ? { outputSchema: raw["outputSchema"] }
            : {}),
          ...(isPlainObject(raw["annotations"])
            ? { annotations: raw["annotations"] }
            : {}),
        });
      }
      const ttl = result["ttlMs"];
      if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0)
        ttlMs = ttl;
      const next = result["nextCursor"];
      if (typeof next === "string" && next) {
        cursor = next;
        continue;
      }
      break;
    }
    return {
      tools,
      ...(this.instructions ? { instructions: this.instructions } : {}),
      ...(this.serverInfo ? { serverInfo: this.serverInfo } : {}),
      era: this.era?.kind === "modern" ? "2026-07-28" : "2025",
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      truncated,
    };
  }

  /** One `tools/call`, the result relayed as the server shaped it. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<UpstreamCallResult> {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      {
        timeoutMs: this.callTimeoutMs,
        maxBytes: this.callMaxBytes,
        signal,
        name,
      },
    );
    if (!isPlainObject(result)) {
      throw new RemoteMcpError(
        "protocol",
        "the server's tools/call answer is not an object",
      );
    }
    if (isPlainObject(result["task"])) {
      throw new RemoteMcpError(
        "protocol",
        "the server answered with a task; this gateway runs tools only",
      );
    }
    if (!Array.isArray(result["content"])) {
      throw new RemoteMcpError(
        "protocol",
        "the server's tools/call answer has no content list",
      );
    }
    const content = result["content"].filter(isPlainObject);
    const structured = result["structuredContent"];
    return {
      content,
      ...(isPlainObject(structured) ? { structuredContent: structured } : {}),
      ...(result["isError"] === true ? { isError: true } : {}),
    };
  }

  /**
   * One JSON-RPC request in whichever era the server speaks, negotiated on
   * the first; the result, or a {@link RemoteMcpError}.
   */
  private async request(
    method: string,
    params: Record<string, unknown>,
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
      name?: string;
    },
  ): Promise<unknown> {
    return (await this.requestCounted(method, params, options)).result;
  }

  /** {@link request}, with how many bytes of answer were read. */
  private async requestCounted(
    method: string,
    params: Record<string, unknown>,
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
      name?: string;
    },
  ): Promise<{ result: unknown; bytes: number }> {
    if (!this.era) {
      // The modern era first: no handshake, so the request itself probes.
      const attempt = await this.send(
        method,
        params,
        { kind: "modern" },
        options,
      );
      if (attempt.ok) {
        this.era = { kind: "modern" };
        return { result: attempt.result, bytes: attempt.bytes };
      }
      if (!attempt.fallback) throw attempt.error;
      this.era = await this.initialize(options.signal);
      // The legacy era then runs the request below.
    }
    if (this.era.kind === "modern") {
      const attempt = await this.send(method, params, this.era, options);
      if (attempt.ok) return { result: attempt.result, bytes: attempt.bytes };
      throw attempt.error;
    }
    const attempt = await this.send(method, params, this.era, options);
    if (attempt.ok) return { result: attempt.result, bytes: attempt.bytes };
    if (attempt.error.status === 404 && this.era.kind === "legacy") {
      // The session ended (a restart, a rotation): once more, fresh.
      this.era = await this.initialize(options.signal);
      const again = await this.send(method, params, this.era, options);
      if (again.ok) return { result: again.result, bytes: again.bytes };
      throw again.error;
    }
    throw attempt.error;
  }

  /** The 2025 handshake: `initialize`, then `notifications/initialized`. */
  private async initialize(signal?: AbortSignal): Promise<Era> {
    const probe: Era = {
      kind: "legacy",
      version: LEGACY_PROTOCOL_VERSION,
      sessionId: null,
    };
    const attempt = await this.send(
      "initialize",
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.clientInfo,
      },
      probe,
      { timeoutMs: this.listTimeoutMs, maxBytes: LIST_MAX_BYTES, signal },
    );
    if (!attempt.ok) throw attempt.error;
    const result = attempt.result;
    if (
      !isPlainObject(result) ||
      typeof result["protocolVersion"] !== "string"
    ) {
      throw new RemoteMcpError(
        "protocol",
        "the server's initialize answer names no protocol version",
      );
    }
    const version = result["protocolVersion"];
    if (!LEGACY_VERSIONS_ACCEPTED.has(version)) {
      throw new RemoteMcpError(
        "protocol",
        `the server speaks MCP ${cleanText(version, 32)}, which this gateway doesn't`,
      );
    }
    if (typeof result["instructions"] === "string" && result["instructions"]) {
      this.instructions = result["instructions"];
    }
    if (isPlainObject(result["serverInfo"])) {
      const info = result["serverInfo"];
      this.serverInfo = {
        ...(typeof info["name"] === "string" ? { name: info["name"] } : {}),
        ...(typeof info["version"] === "string"
          ? { version: info["version"] }
          : {}),
      };
    }
    const era: Era = {
      kind: "legacy",
      version,
      sessionId: attempt.sessionId ?? null,
    };
    // The spec's follow-up; a server may answer 202 or 200 with nothing.
    await this.notify("notifications/initialized", era, signal).catch(
      () => undefined,
    );
    return era;
  }

  private async notify(
    method: string,
    era: Era,
    signal?: AbortSignal,
  ): Promise<void> {
    await withTimeout(this.listTimeoutMs, async (deadline) => {
      const response = await this.fetchImpl(
        new Request(this.url, {
          method: "POST",
          headers: this.requestHeaders(era, method),
          body: JSON.stringify({ jsonrpc: "2.0", method }),
          redirect: "manual",
          signal: anySignal(deadline, signal),
        }),
      );
      await response.body?.cancel().catch(() => undefined);
    });
  }

  private requestHeaders(
    era: Era,
    method: string,
    name?: string,
  ): Record<string, string> {
    const common = {
      ...this.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (era.kind === "modern") {
      return {
        ...common,
        "mcp-protocol-version": MODERN_PROTOCOL_VERSION,
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      };
    }
    return {
      ...common,
      ...(method === "initialize"
        ? {}
        : { "mcp-protocol-version": era.version }),
      ...(era.sessionId ? { "mcp-session-id": era.sessionId } : {}),
    };
  }

  private async send(
    method: string,
    params: Record<string, unknown>,
    era: Era,
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
      name?: string;
    },
  ): Promise<
    | { ok: true; result: unknown; sessionId?: string; bytes: number }
    | { ok: false; error: RemoteMcpError; fallback: boolean }
  > {
    const id = this.nextId++;
    const body =
      era.kind === "modern"
        ? {
            jsonrpc: "2.0",
            id,
            method,
            params: {
              ...params,
              _meta: {
                [META_PROTOCOL]: MODERN_PROTOCOL_VERSION,
                [META_CLIENT_INFO]: this.clientInfo,
                [META_CLIENT_CAPABILITIES]: {},
              },
            },
          }
        : { jsonrpc: "2.0", id, method, params };
    let response: Response;
    let text: string;
    let messages: unknown[];
    let bytes: number;
    try {
      const read = await withTimeout(options.timeoutMs, async (deadline) => {
        const signal = anySignal(deadline, options.signal);
        const fetched = await this.fetchImpl(
          new Request(this.url, {
            method: "POST",
            headers: this.requestHeaders(era, method, options.name),
            body: JSON.stringify(body),
            redirect: "manual",
            signal,
          }),
        );
        const capped = await readAnswer(fetched, options.maxBytes, signal, id);
        return { fetched, capped };
      });
      response = read.fetched;
      if (!read.capped.ok) {
        return {
          ok: false,
          fallback: false,
          error: new RemoteMcpError(
            "too_large",
            `the server's answer is larger than ${Math.round(options.maxBytes / 1024)} KB`,
            { status: response.status },
          ),
        };
      }
      text = read.capped.text;
      messages = read.capped.messages;
      bytes = read.capped.bytes;
    } catch (error) {
      if (options.signal?.aborted) {
        return {
          ok: false,
          fallback: false,
          error: new RemoteMcpError("timeout", "the call was cancelled"),
        };
      }
      if (error instanceof TimeoutError) {
        return {
          ok: false,
          fallback: false,
          error: new RemoteMcpError(
            "timeout",
            `the server did not answer within ${Math.round(options.timeoutMs / 1000)} seconds`,
          ),
        };
      }
      return {
        ok: false,
        fallback: false,
        error: new RemoteMcpError(
          "unreachable",
          "the server could not be reached",
          {
            head: sanitizedHead(
              error instanceof Error ? error.message : String(error),
              this.secrets,
            ),
          },
        ),
      };
    }

    const status = response.status;
    if (status >= 300 && status < 400) {
      return {
        ok: false,
        fallback: false,
        error: new RemoteMcpError(
          "redirect",
          "the server redirected; the gateway follows no redirects",
          { status },
        ),
      };
    }
    if (status === 401 || status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      return {
        ok: false,
        fallback: false,
        error: new RemoteMcpError(
          status === 401 ? "unauthorized" : "forbidden",
          status === 401
            ? "the server rejected the credential (401)"
            : "the server refused the request (403)",
          {
            status,
            head: sanitizedHead(text, this.secrets),
            wantsOAuth: /resource_metadata=/i.test(challenge),
          },
        ),
      };
    }
    if (status >= 400) {
      const rpc = messages.find(
        (message) =>
          isResponseTo(message, id) ||
          (isPlainObject(message) && "error" in message),
      );
      const code =
        isPlainObject(rpc) && isPlainObject(rpc["error"])
          ? rpc["error"]["code"]
          : undefined;
      return {
        ok: false,
        // A 2025-era server answers a modern request with 400 (unsupported
        // version, not initialized, bad request): try its era.
        fallback: era.kind === "modern" && status >= 400 && status < 500,
        error: new RemoteMcpError("http", `the server answered ${status}`, {
          status,
          ...(typeof code === "number" ? { code } : {}),
          head: sanitizedHead(text, this.secrets),
        }),
      };
    }
    // A notification's or an accepted request's empty answer.
    if (!text.trim()) {
      return {
        ok: false,
        fallback: false,
        error: new RemoteMcpError(
          "protocol",
          `the server answered ${status} with no body`,
          { status },
        ),
      };
    }
    for (const message of messages) {
      if (isResponseTo(message, id)) {
        if (message.error !== undefined) {
          const code =
            typeof message.error?.code === "number"
              ? message.error.code
              : undefined;
          const text =
            typeof message.error?.message === "string"
              ? message.error.message
              : "";
          // -32601 method not found / -32600 invalid request on a modern
          // request: a server that doesn't speak that era.
          const fallback =
            era.kind === "modern" &&
            (code === -32601 || code === -32600 || code === -32000);
          return {
            ok: false,
            fallback,
            error: new RemoteMcpError(
              "rpc",
              `the server answered an error${code !== undefined ? ` (${code})` : ""}`,
              {
                status,
                ...(code !== undefined ? { code } : {}),
                head: sanitizedHead(text, this.secrets),
              },
            ),
          };
        }
        return {
          ok: true,
          result: message.result,
          bytes,
          ...(response.headers.get("mcp-session-id")
            ? { sessionId: response.headers.get("mcp-session-id")! }
            : {}),
        };
      }
      if (isServerRequest(message)) {
        return {
          ok: false,
          fallback: false,
          error: new RemoteMcpError(
            "protocol",
            `the server asked for ${cleanText(message.method, 64)}, which this gateway doesn't do`,
          ),
        };
      }
    }
    return {
      ok: false,
      fallback: era.kind === "modern",
      error: new RemoteMcpError(
        "protocol",
        "the server's answer carried no result for the request",
        {
          status,
          head: sanitizedHead(text, this.secrets),
        },
      ),
    };
  }
}

type ReadAnswer =
  | { ok: true; text: string; messages: unknown[]; bytes: number }
  | { ok: false; bytes: number };

/**
 * The server's answer: a JSON body read whole within the cap, or an SSE
 * stream read frame by frame, within the cap, until the message with the
 * request's id (or a server-to-client request, which ends the call)
 * arrives, so a server that keeps the stream open after answering (the
 * spec says it should close it) doesn't hold the call to its deadline.
 */
async function readAnswer(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  id: number,
): Promise<ReadAnswer> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const capped = await readTextCapped(response, maxBytes, signal);
    return capped.ok
      ? {
          ok: true,
          text: capped.text,
          messages: parsedJson(capped.text),
          bytes: capped.bytes,
        }
      : { ok: false, bytes: capped.bytes };
  }
  if (!response.body) return { ok: true, text: "", messages: [], bytes: 0 };
  const reader = response.body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });
  const decoder = new TextDecoder();
  const messages: unknown[] = [];
  let buffer = "";
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, bytes };
      }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      buffer += chunk.replace(/\r\n|\r/g, "\n");
      // Complete frames end in a blank line; the rest waits for more.
      const end = buffer.lastIndexOf("\n\n");
      if (end < 0) continue;
      const complete = buffer.slice(0, end + 2);
      buffer = buffer.slice(end + 2);
      const parsed = sseMessages(complete);
      messages.push(...parsed);
      if (
        parsed.some(
          (message) => isResponseTo(message, id) || isServerRequest(message),
        )
      ) {
        await reader.cancel().catch(() => undefined);
        return { ok: true, text, messages, bytes };
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
  messages.push(...sseMessages(buffer + decoder.decode()));
  return { ok: true, text, messages, bytes };
}

function parsedJson(text: string): unknown[] {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/** A signal that aborts when either does; `undefined` when neither is given. */
function anySignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return controller.signal;
}
