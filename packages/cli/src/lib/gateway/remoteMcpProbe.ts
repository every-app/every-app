/**
 * `everyapp mcp add <url>`'s one look at a remote MCP server from the
 * operator's machine, with no credential (docs/design/2026-10-mcp-by-url.md,
 * section 4): enough to say what was found, never a reason to refuse. The
 * operator may be adding a server their laptop can't reach (a VPN, an
 * allowlist of Cloudflare's addresses), and the Gateway, not this machine,
 * is what fetches it afterwards.
 *
 * One POST of a 2026-07-28 `tools/list` (the era the ToolBus itself
 * serves: per-request `Mcp-Method` and `_meta`, no session); when that
 * isn't a JSON-RPC result, one POST of a 2025 `initialize`. Answers are
 * read as JSON or as SSE (`data:` lines), capped. No redirect is followed,
 * as the Gateway follows none. 10 seconds in all.
 *
 * A 401's `WWW-Authenticate: Bearer resource_metadata=…` is what tells
 * `mcp add` the server signs in with OAuth (the MCP authorization spec);
 * the challenge's metadata URL and scope are kept for discovery. Given a
 * `credential` (the headers and query parameters a static key becomes),
 * the same look checks the key once `mcp add` set it: `listTools` then
 * completes a 2025 server's session to count its tools.
 */
import { parseWwwAuthenticate } from "@every-app/sdk/internal";

/** The protocol revision the ToolBus serves and the probe asks for first. */
const MODERN_ERA = "2026-07-28";
/** The 2025 revision `initialize` asks for. */
const LEGACY_ERA = "2025-11-25";
const PROBE_TIMEOUT_MS = 10_000;
/** The most of an answer the probe reads. */
const BODY_CAP_BYTES = 1024 * 1024;

export type RemoteMcpProbe =
  /** It answered MCP without a credential. `tools` only when the modern era listed them. */
  | { outcome: "reachable"; era: string; tools: number | null; server: string | null }
  /**
   * 401 or 403: it wants a credential; `oauth` when its Bearer challenge
   * names `resource_metadata` (kept as `resourceMetadata`, with its `scope`).
   */
  | { outcome: "needs-credential"; status: number; oauth: boolean; resourceMetadata?: string; scope?: string }
  /** A 3xx: the Gateway follows no redirects. */
  | { outcome: "redirected"; status: number; location: string | null }
  /** No answer, or not an MCP answer. */
  | { outcome: "unreachable"; reason: string };

interface ProbeOptions {
  /** The CLI's version, for `clientInfo`. */
  version: string;
  /** The fetch to use (tests). */
  fetch?: typeof fetch;
  /** The whole probe's budget (tests shorten it). */
  timeoutMs?: number;
  /** A static credential to send: headers to set, query parameters to add to the URL. */
  credential?: { headers: Record<string, string>; query: Record<string, string> };
  /** Count a 2025 server's tools too: `notifications/initialized`, then `tools/list` in its session. */
  listTools?: boolean;
}

/** The URL with a credential's query parameters added. */
function withQuery(url: string, query: Record<string, string>): string {
  if (Object.keys(query).length === 0) return url;
  const target = new URL(url);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
  return target.toString();
}

/** Look at `url` once, without a credential. Never throws. */
export async function probeRemoteMcp(url: string, options: ProbeOptions): Promise<RemoteMcpProbe> {
  const fetcher = options.fetch ?? fetch;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const clientInfo = { name: "everyapp-cli", version: options.version };
  const credential = options.credential?.headers ?? {};
  try {
    url = withQuery(url, options.credential?.query ?? {});
  } catch {
    return { outcome: "unreachable", reason: "the URL doesn't parse" };
  }
  try {
    const listed = await post(fetcher, url, deadline, {
      headers: { ...credential, "mcp-protocol-version": MODERN_ERA, "mcp-method": "tools/list" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN_ERA,
            "io.modelcontextprotocol/clientInfo": clientInfo,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
    });
    if (listed.kind === "final") return listed.probe;
    const result = listed.message ? resultOf(listed.message) : null;
    if (result && Array.isArray(result["tools"])) {
      const meta = record(result["_meta"]);
      const info = record(meta?.["io.modelcontextprotocol/serverInfo"]);
      return {
        outcome: "reachable",
        era: MODERN_ERA,
        tools: result["tools"].length,
        server: typeof info?.["name"] === "string" ? info["name"] : null,
      };
    }
    const initialized = await post(fetcher, url, deadline, {
      headers: { ...credential },
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: LEGACY_ERA, capabilities: {}, clientInfo },
      },
    });
    if (initialized.kind === "final") return initialized.probe;
    const init = initialized.message ? resultOf(initialized.message) : null;
    if (init && typeof init["protocolVersion"] === "string") {
      const info = record(init["serverInfo"]);
      const era = init["protocolVersion"];
      const tools = options.listTools
        ? await legacyToolCount(fetcher, url, deadline, {
            ...credential,
            "mcp-protocol-version": era,
            ...(initialized.session ? { "mcp-session-id": initialized.session } : {}),
          })
        : null;
      if (tools !== null && typeof tools === "object") return tools;
      return {
        outcome: "reachable",
        era,
        tools,
        server: typeof info?.["name"] === "string" ? info["name"] : null,
      };
    }
    return { outcome: "unreachable", reason: notMcp(listed.status, initialized.status) };
  } catch (error) {
    return { outcome: "unreachable", reason: failureReason(error, deadline) };
  }
}

/**
 * A 2025 server's tool count, in the session `initialize` opened: the
 * `notifications/initialized` it waits for, then one `tools/list`. Null
 * when it doesn't answer a list; the probe's classification when the
 * list is refused (a 401 or 403 there means the credential wasn't taken).
 */
async function legacyToolCount(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<number | null | RemoteMcpProbe> {
  const notified = await post(fetcher, url, signal, {
    headers,
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  if (notified.kind === "final") return notified.probe;
  const listed = await post(fetcher, url, signal, {
    headers,
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  });
  if (listed.kind === "final") return listed.probe;
  const result = listed.message ? resultOf(listed.message) : null;
  return result && Array.isArray(result["tools"]) ? result["tools"].length : null;
}

/** What one POST came to: a classification that ends the probe, or a body to read. */
type Answer =
  | { kind: "final"; probe: RemoteMcpProbe }
  | { kind: "message"; status: number; message: Record<string, unknown> | null; session: string | null };

async function post(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  request: { headers: Record<string, string>; body: Record<string, unknown> },
): Promise<Answer> {
  const response = await fetcher(url, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...request.headers,
    },
    body: JSON.stringify(request.body),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    return {
      kind: "final",
      probe: { outcome: "redirected", status: response.status, location: response.headers.get("location") },
    };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    const challenge = parseWwwAuthenticate(response.headers.get("www-authenticate"));
    return {
      kind: "final",
      probe: {
        outcome: "needs-credential",
        status: response.status,
        oauth: Boolean(challenge?.resourceMetadata),
        ...(challenge?.resourceMetadata ? { resourceMetadata: challenge.resourceMetadata } : {}),
        ...(challenge?.scope ? { scope: challenge.scope } : {}),
      },
    };
  }
  const session = response.headers.get("mcp-session-id");
  const id = request.body["id"];
  if (id === undefined) {
    // A notification: nothing to read but that it was taken.
    await response.body?.cancel().catch(() => undefined);
    return { kind: "message", status: response.status, message: null, session };
  }
  const text = await readCapped(response);
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const message = type.includes("text/event-stream") ? sseMessage(text, id) : jsonMessage(text);
  return { kind: "message", status: response.status, message, session };
}

/** The body as text, at most {@link BODY_CAP_BYTES}. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= BODY_CAP_BYTES) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    // An SSE answer ends with the message; a stream held open after it
    // (a server that keeps the response for notifications) needn't be read on.
    if (/\n\n/.test(text) && sseHasResponse(text)) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

function jsonMessage(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    // A batch answer: the first response in it.
    if (Array.isArray(parsed)) return record(parsed.find((item) => record(item) && "id" in item));
    return record(parsed);
  } catch {
    return null;
  }
}

/** Each SSE event's data, joined, as a JSON value (unparseable ones skipped). */
function sseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const parsed = record(JSON.parse(data));
      if (parsed) events.push(parsed);
    } catch {
      // A partial or non-JSON event: not the answer.
    }
  }
  return events;
}

/** Whether the SSE text read so far holds a JSON-RPC response (an id with a result or error). */
function sseHasResponse(text: string): boolean {
  return sseEvents(text).some((event) => "id" in event && ("result" in event || "error" in event));
}

/** The SSE message answering `id` (notifications in between are skipped). */
function sseMessage(text: string, id: unknown): Record<string, unknown> | null {
  const events = sseEvents(text);
  return (
    events.find((event) => event["id"] === id && ("result" in event || "error" in event)) ??
    events.find((event) => "result" in event || "error" in event) ??
    null
  );
}

function resultOf(message: Record<string, unknown>): Record<string, unknown> | null {
  return message["jsonrpc"] === "2.0" ? record(message["result"]) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Two answers that weren't MCP, in a few words. */
function notMcp(listStatus: number, initializeStatus: number): string {
  const ok = (status: number) => status >= 200 && status < 300;
  if (ok(listStatus) || ok(initializeStatus)) return "it answered, but not as an MCP server";
  if (listStatus === initializeStatus) return `it answered ${listStatus}`;
  return `it answered ${listStatus} to tools/list and ${initializeStatus} to initialize`;
}

/** Node's system error codes, in the words a person reads (TLS ones by prefix). */
const NETWORK_FAILURES: ReadonlyArray<[RegExp, string]> = [
  [/^(ENOTFOUND|EAI_AGAIN)$/, "its host name doesn't resolve from here"],
  [/^ECONNREFUSED$/, "it refused the connection"],
  [/^(ERR_TLS|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY)/, "its TLS certificate wasn't accepted"],
];

/** A failed fetch in a few words, never the request. */
function failureReason(error: unknown, deadline: AbortSignal): string {
  if (deadline.aborted) return "it didn't answer within 10 seconds";
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const system = typeof cause?.code === "string" ? cause.code : null;
  if (!system) return "it couldn't be reached";
  const known = NETWORK_FAILURES.find(([pattern]) => pattern.test(system));
  return known ? known[1] : `it couldn't be reached (${system})`;
}
