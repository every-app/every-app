/**
 * HTTP serving for the ToolBus: one stateless handler for both MCP eras.
 *
 *  - 2026-07-28 traffic (a per-request `_meta` envelope) goes to the SDK's
 *    own `createMcpHandler`: strict, JSON responses, no subscriptions held
 *    by the SDK.
 *  - 2025-06-18 / 2025-11-25 traffic (the initialize handshake and requests
 *    without the envelope) gets a fresh JSON-mode Streamable HTTP transport
 *    per request, closed before the response returns.
 *
 * Nothing is kept between requests, yet a connected client learns when the
 * tools it may see change (an app added, removed or redeployed):
 *
 *  - 2025 eras: `initialize` issues an `Mcp-Session-Id` whose last part is a
 *    hash of the caller's tool list (spec: a server MAY assign a session id
 *    at initialization, and the client then sends it on every request), and
 *    whose middle part, when the client named itself in `initialize`, is
 *    that name for the audit row (nothing else keeps it between requests). A
 *    later request carrying a hash other than the current one is answered
 *    as an SSE stream, `notifications/tools/list_changed` before the result
 *    (the spec lets a server send notifications related to the request
 *    before its response); a `tools/list` on such a session gets HTTP 404
 *    Session not found, so the client initializes again and its new session
 *    carries the current hash. Clients that take an `Mcp-Session-Id` from a
 *    later response (the 2025 SDK) get the new one with the notification.
 *  - 2026-07-28: there are no sessions and the spec routes list changes
 *    through `subscriptions/listen`. When the view can be re-read
 *    (`view.refresh`), that request is held open as an SSE stream, the view
 *    re-read every `listenPollMs`, the notification pushed when the hash
 *    differs, and the stream ended gracefully after `listenMaxMs` (the client
 *    opens a new one). Only a request the SDK's classifier accepts as a
 *    2026-07-28 request is held, at most a few per credential per isolate;
 *    anything else goes to the SDK, which answers as the spec says. Without
 *    `refresh` the modern era declares `listChanged: false`, so clients
 *    don't ask.
 *
 * First it checks Origin (and, in local dev, Host) as the Streamable HTTP
 * spec requires: a browser may call from the endpoint's own origin, from an
 * origin the view allows (the gateway's MCP_ALLOWED_ORIGINS), and in local
 * dev from any localhost origin (MCP Inspector), whose CORS preflights it
 * answers. On an app host the perimeter authenticates every request first,
 * so a cross-origin preflight (which carries no credentials) never gets
 * here; on the gateway the OAuth resource server answers preflights.
 */
import {
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type JSONRPCRequest,
  type McpHttpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { scopesForAccess } from "./execute";
import { isPlainObject } from "./io";
import {
  cleanClientText,
  createToolBusServer,
  describeClient,
  MAX_CLIENT_INFO_LENGTH,
  toolListHash,
  TOOLBUS_VERSION,
} from "./server";
import type { ToolBusDeps, ToolBusView } from "./types";

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
/** A held `subscriptions/listen` stream re-reads the view this often. */
const LISTEN_POLL_MS = 30_000;
/** And ends gracefully after this long; the client opens a new one. */
const LISTEN_MAX_MS = 10 * 60_000;
/**
 * Streams one credential may hold on one isolate (Claude Code holds one);
 * more are refused in-band like the SDK refuses past its own limit.
 */
const LISTEN_STREAMS_PER_CALLER = 8;
/** Longest client part of a 2025 session id, base64url characters. */
const MAX_SESSION_CLIENT_LENGTH = 128;
/** The bytes of client text that encode to at most that many. */
const MAX_SESSION_CLIENT_BYTES = (MAX_SESSION_CLIENT_LENGTH / 4) * 3;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const VIEW_KEY = "everyapp.toolbus.view";
const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const LIST_CHANGED = {
  jsonrpc: "2.0",
  method: "notifications/tools/list_changed",
} as const;
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
};
const CORS_ALLOW_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  "last-event-id",
  "mcp-method",
  "mcp-name",
  "mcp-protocol-version",
  "mcp-session-id",
].join(", ");

export type ToolBusHttpHandler = (
  request: Request,
  view: ToolBusView,
) => Promise<Response>;

/**
 * Build the handler. Create it once per isolate: each request's view (the
 * caller and its apps) travels with the request, not the handler.
 */
export function createToolBusHttp(deps: ToolBusDeps): ToolBusHttpHandler {
  // Open subscriptions/listen streams per credential, on this isolate.
  const held = new Map<string, number>();
  // Built on first use: the SDK logs a notice whenever a JSON-mode handler
  // is created, which only belongs in logs that actually serve MCP.
  let modern: McpHttpHandler | undefined;
  const modernHandler = () =>
    (modern ??= createMcpHandler(
      (context) => {
        const view = viewOf(context);
        return createToolBusServer(
          view,
          deps,
          context.requestInfo?.headers.get("mcp-protocol-version") ?? undefined,
          { listChanged: view.refresh !== undefined },
        );
      },
      {
        legacy: "reject",
        responseMode: "json",
        maxSubscriptions: 0,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      },
    ));

  return async (request, view) => {
    const refused = refuseUntrusted(request, deps, view);
    if (refused) return refused;
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": CORS_ALLOW_HEADERS,
          "access-control-max-age": "600",
        },
      });
    }
    if (request.method !== "POST") {
      // Stateless: there is no server-initiated stream to GET or session to
      // DELETE, which Streamable HTTP lets a server answer with 405.
      return withHeaders(
        jsonRpcError(405, -32000, "Method not allowed.", {
          allow: "POST, OPTIONS",
        }),
        cors,
      );
    }
    // Read once, within the limit (a chunked body declares no length), and
    // hand the parsed body to every leg, so none reads it again.
    let read: Awaited<ReturnType<typeof readRequestBody>>;
    try {
      read = await readRequestBody(
        // Workers' Request generics differ from the SDK's; one object at runtime.
        request.clone() as unknown as Parameters<typeof readRequestBody>[0],
        MAX_REQUEST_BODY_BYTES,
      );
    } catch {
      return withHeaders(
        jsonRpcError(
          400,
          -32700,
          "Parse error: the request body could not be read.",
        ),
        cors,
      );
    }
    if (read.tooLarge) {
      return withHeaders(
        jsonRpcError(413, -32600, "Request body too large."),
        cors,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(read.text);
    } catch {
      body = undefined;
    }

    const authInfo: AuthInfo = {
      token: "toolbus",
      clientId: view.principal.credential.id,
      scopes: scopesForAccess(view.principal.access),
      extra: { [VIEW_KEY]: view },
    };
    const parsed = body !== undefined ? { parsedBody: body } : {};
    // Options go in the third argument; the second is a pre-parsed body.
    const legacy = await isLegacyRequest(request, body, {
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    });
    let response: Response;
    const listen = view.refresh ? listenRequest(request, body) : null;
    if (legacy) {
      response = await serveLegacy(request, view, deps, authInfo, body);
    } else if (listen) {
      response = await serveListen(request, view, deps, listen, held);
    } else {
      response = await modernHandler().fetch(request, { authInfo, ...parsed });
    }
    return withHeaders(response, cors);
  };
}

/**
 * The body as a 2026-07-28 `subscriptions/listen` request the SDK's
 * classifier accepts (envelope, headers and version checked as it does),
 * else null: the SDK then answers with the spec's error.
 */
function listenRequest(request: Request, body: unknown): JSONRPCRequest | null {
  if (
    request.headers.get("mcp-method") !== "subscriptions/listen" ||
    request.headers.get("mcp-protocol-version") !== MODERN_PROTOCOL_VERSION ||
    !isJsonContentType(request.headers.get("content-type"))
  ) {
    return null;
  }
  const outcome = classifyInboundRequest({
    httpMethod: request.method,
    protocolVersionHeader: request.headers.get("mcp-protocol-version")!,
    mcpMethodHeader: "subscriptions/listen",
    mcpNameHeader: request.headers.get("mcp-name") ?? undefined,
    body,
  });
  return outcome.kind === "modern" &&
    outcome.messageKind === "request" &&
    outcome.message.method === "subscriptions/listen" &&
    outcome.classification.revision === MODERN_PROTOCOL_VERSION
    ? outcome.message
    : null;
}

function viewOf(context: McpRequestContext): ToolBusView {
  const view = context.authInfo?.extra?.[VIEW_KEY];
  if (!view) throw new Error("ToolBus request has no view");
  return view as ToolBusView;
}

async function serveLegacy(
  request: Request,
  view: ToolBusView,
  deps: ToolBusDeps,
  authInfo: AuthInfo,
  body: unknown,
): Promise<Response> {
  // Neither 2025-06-18 nor 2025-11-25 has JSON-RPC batches (the modern leg
  // refuses them too). A batch would also slip past the routing-header
  // check below and fan one request out into a call per message.
  if (Array.isArray(body)) {
    return jsonRpcError(
      400,
      -32600,
      "Bad Request: JSON-RPC batches are not supported by this endpoint.",
    );
  }
  // 2025-era clients don't send Mcp-Method / Mcp-Name, but anything that
  // routes or logs on them must not be fooled: the body is what runs.
  const mismatch = headerMismatch(request.headers, body);
  if (mismatch) {
    return jsonRpcError(400, -32020, `Bad Request: ${mismatch}`, {}, body);
  }

  const method = isPlainObject(body) ? body["method"] : undefined;
  const params =
    isPlainObject(body) && isPlainObject(body["params"]) ? body["params"] : {};
  const hash = await toolListHash(view);
  const session = request.headers.get("mcp-session-id");
  const sessionHash = toolsHashOfSession(session);
  const changed = sessionHash !== undefined && sessionHash !== hash;
  // The client named at initialize: minted into that session, read back
  // from every later request on it, and carried into a rotated session.
  const client =
    method === "initialize"
      ? describeClient(params["clientInfo"])
      : clientOfSession(session);
  // The session was issued for another tool list. Its tools/list ends the
  // session (spec: the server MAY terminate a session at any time, and the
  // client MUST then initialize again), so the new session carries the
  // current hash and the notification below stops repeating.
  if (changed && method === "tools/list") {
    return jsonRpcError(404, -32001, "Session not found");
  }

  const server = createToolBusServer(
    view,
    deps,
    request.headers.get("mcp-protocol-version") ?? undefined,
    { listChanged: true, ...(client ? { clientInfo: client } : {}) },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Only initialize mints a session; later requests validate nothing, so
    // a client without one, or with one from before a deploy, is served.
    sessionIdGenerator:
      method === "initialize" ? () => sessionIdFor(hash, client) : undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      authInfo,
      ...(body !== undefined ? { parsedBody: body } : {}),
    });
    return changed &&
      isJsonRpcRequest(body) &&
      method !== "initialize" &&
      acceptsEventStream(request)
      ? await withListChanged(response, hash, client)
      : response;
  } finally {
    await Promise.all([
      transport.close().catch(() => undefined),
      server.close().catch(() => undefined),
    ]);
  }
}

/**
 * `<uuid>.<client>.<tool list hash>`, or `<uuid>.<tool list hash>` when the
 * client gave no `clientInfo`: visible ASCII, unguessable (the uuid),
 * self-describing. The client part is the client's own description
 * (`describeClient`), base64url without padding and bounded, so later
 * calls on the session are audited with the name given once at initialize.
 */
function sessionIdFor(hash: string, client?: string): string {
  const encoded = client ? encodeSessionClient(client) : "";
  return encoded
    ? `${crypto.randomUUID()}.${encoded}.${hash}`
    : `${crypto.randomUUID()}.${hash}`;
}

function encodeSessionClient(client: string): string {
  const encoder = new TextEncoder();
  // Cut by character, never mid-byte, until the encoding fits.
  let text = client;
  let bytes = encoder.encode(text);
  while (bytes.length > MAX_SESSION_CLIENT_BYTES) {
    text = Array.from(text).slice(0, -1).join("");
    bytes = encoder.encode(text);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The client a session id carries: undefined for the two-part form, for a
 * middle part that isn't base64url or doesn't decode as UTF-8, and for one
 * that decodes to nothing visible. The header is the client's to tamper
 * with, so what comes out is cleaned and bounded like a fresh description.
 */
function clientOfSession(header: string | null): string | undefined {
  const parts = header?.split(".") ?? [];
  const encoded = parts.length === 3 ? parts[1] : undefined;
  if (
    !encoded ||
    encoded.length > MAX_SESSION_CLIENT_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return undefined;
  }
  try {
    const padded =
      encoded.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (encoded.length % 4)) % 4);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
    );
    return cleanClientText(text, MAX_CLIENT_INFO_LENGTH) || undefined;
  } catch {
    return undefined;
  }
}

function toolsHashOfSession(header: string | null): string | undefined {
  const hash = header?.slice(header.lastIndexOf(".") + 1);
  return hash && /^[0-9a-f]{16}$/.test(hash) ? hash : undefined;
}

function isJsonRpcRequest(body: unknown): boolean {
  return (
    isPlainObject(body) && typeof body["method"] === "string" && "id" in body
  );
}

function acceptsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

function sseEvent(message: unknown): string {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * The JSON-mode response as an SSE stream, `notifications/tools/list_changed`
 * before the result. The new session id (the same client, the current
 * hash) is for clients that take one from any response; the others reach
 * the 404 above on their next tools/list.
 */
async function withListChanged(
  response: Response,
  hash: string,
  client: string | undefined,
): Promise<Response> {
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SSE_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("mcp-session-id", sessionIdFor(hash, client));
  return new Response(
    `${sseEvent(LIST_CHANGED)}event: message\ndata: ${await response.text()}\n\n`,
    { status: 200, headers },
  );
}

/** The spec's subscription filter: booleans, and resource URIs as strings. */
function validFilter(filter: Record<string, unknown>): boolean {
  for (const key of [
    "toolsListChanged",
    "promptsListChanged",
    "resourcesListChanged",
  ]) {
    if (key in filter && typeof filter[key] !== "boolean") return false;
  }
  const uris = filter["resourceSubscriptions"];
  return (
    uris === undefined ||
    (Array.isArray(uris) && uris.every((uri) => typeof uri === "string"))
  );
}

/**
 * Who holds a stream, for the cap: the credential's own id, or the user's
 * when the credential has none (a browser session).
 */
function streamHolder(view: ToolBusView): string {
  const { credential } = view.principal;
  return credential.id === "session" || credential.id === "pat"
    ? `${credential.kind}:${view.principal.userId}`
    : credential.id;
}

/**
 * A 2026-07-28 `subscriptions/listen`, held open: the acknowledgement
 * first, then every `listenPollMs` either `notifications/tools/list_changed`
 * (the re-read view lists other tools) or an SSE comment as keep-alive;
 * after `listenMaxMs`, or when the view can't be re-read within a poll, the
 * request's completion result closes it gracefully. Only `toolsListChanged`
 * is served; a filter without it is acknowledged and closed at once.
 */
async function serveListen(
  request: Request,
  view: ToolBusView,
  deps: ToolBusDeps,
  message: JSONRPCRequest,
  held: Map<string, number>,
): Promise<Response> {
  const id = message.id;
  if (!acceptsEventStream(request)) {
    return jsonRpcError(
      406,
      -32000,
      "Not Acceptable: Client must accept text/event-stream",
    );
  }
  const params = isPlainObject(message.params) ? message.params : {};
  const filter = params["notifications"];
  if (!isPlainObject(filter) || !validFilter(filter)) {
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: isPlainObject(filter)
          ? "notifications: invalid subscription filter"
          : "notifications is required",
      },
    });
  }
  const wanted = filter["toolsListChanged"] === true;
  const refresh = view.refresh;
  if (!refresh) throw new Error("subscriptions/listen needs view.refresh");
  const caller = streamHolder(view);
  if ((held.get(caller) ?? 0) >= LISTEN_STREAMS_PER_CALLER) {
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: "Subscription limit reached" },
    });
  }
  // Reserved before anything is awaited: a burst of opens counts too.
  held.set(caller, (held.get(caller) ?? 0) + 1);
  const release = () => {
    const count = (held.get(caller) ?? 1) - 1;
    if (count > 0) held.set(caller, count);
    else held.delete(caller);
  };
  const pollMs = deps.listenPollMs ?? LISTEN_POLL_MS;
  const maxMs = deps.listenMaxMs ?? LISTEN_MAX_MS;
  const meta = { [SUBSCRIPTION_ID_KEY]: id };
  const encoder = new TextEncoder();
  let last: string;
  try {
    last = await toolListHash(view);
  } catch (error) {
    release();
    throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      const end = () => {
        if (closed) return;
        closed = true;
        release();
        write(
          sseEvent({
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              _meta: { ...meta, [SERVER_INFO_KEY]: serverInfo(view) },
            },
          }),
        );
        controller.close();
      };
      write(
        sseEvent({
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: wanted ? { toolsListChanged: true } : {},
            _meta: meta,
          },
        }),
      );
      if (!wanted) {
        end();
        return;
      }
      const opened = Date.now();
      const tick = async () => {
        if (closed) return;
        if (Date.now() - opened >= maxMs) {
          end();
          return;
        }
        let current: string;
        try {
          current = await toolListHash(await withinPoll(refresh(), pollMs));
        } catch {
          end();
          return;
        }
        if (closed) return;
        if (current === last) {
          write(": keepalive\n\n");
        } else {
          last = current;
          write(sseEvent({ ...LIST_CHANGED, params: { _meta: meta } }));
        }
        timer = setTimeout(tick, pollMs);
      };
      timer = setTimeout(tick, pollMs);
    },
    cancel() {
      if (!closed) release();
      closed = true;
      clearTimeout(timer);
    },
  });
  // The runtime cancels the stream when the client goes; its abort signal
  // says so too, in case the response was never read.
  request.signal?.addEventListener("abort", () => {
    if (!closed) release();
    closed = true;
    clearTimeout(timer);
  });
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function serverInfo(view: ToolBusView) {
  return {
    name: view.serverInfo.name,
    ...(view.serverInfo.title ? { title: view.serverInfo.title } : {}),
    version: TOOLBUS_VERSION,
  };
}

/** A re-read that takes longer than a poll ends the stream instead. */
function withinPoll<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("refresh timed out")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Decode the spec's `=?base64?…?=` form of a non-ASCII header value. */
function headerValue(raw: string): string {
  const encoded = /^=\?base64\?(.*)\?=$/i.exec(raw)?.[1];
  if (encoded === undefined) return raw;
  try {
    return new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
    );
  } catch {
    return raw;
  }
}

function headerMismatch(headers: Headers, body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  const method = headers.get("mcp-method");
  if (method !== null && headerValue(method) !== body["method"]) {
    return `the Mcp-Method header names "${method}" but the body is "${String(body["method"])}"`;
  }
  const name = headers.get("mcp-name");
  if (name !== null) {
    const params = isPlainObject(body["params"]) ? body["params"] : {};
    const target = params["name"] ?? params["uri"];
    if (headerValue(name) !== target) {
      return `the Mcp-Name header names "${name}" but the body names "${String(target)}"`;
    }
  }
  return null;
}

function isLocalhostHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower === "127.0.0.1" ||
    lower === "[::1]"
  );
}

function refuseUntrusted(
  request: Request,
  deps: ToolBusDeps,
  view: ToolBusView,
): Response | null {
  // Production dispatch has already matched the Host to an app or the
  // gateway. Locally, only localhost-class hosts may reach the ToolBus, so
  // a DNS-rebinding page can't.
  if (deps.localhostOnly) {
    let hostname: string | null = null;
    try {
      hostname = new URL(`http://${request.headers.get("host") ?? ""}`)
        .hostname;
    } catch {
      hostname = null;
    }
    if (!hostname || !isLocalhostHostname(hostname)) {
      return jsonRpcError(403, -32000, "Forbidden: invalid Host header.");
    }
  }

  const origin = request.headers.get("origin");
  if (origin === null || originAllowed(origin, request, deps, view)) {
    return null;
  }
  return jsonRpcError(403, -32000, "Forbidden: origin not allowed.");
}

function originAllowed(
  origin: string,
  request: Request,
  deps: ToolBusDeps,
  view: ToolBusView,
): boolean {
  if (origin === new URL(request.url).origin) return true;
  if (view.allowedOrigins?.includes(origin.toLowerCase())) return true;
  if (!deps.localhostOnly) return false;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isLocalhostHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/** CORS for an allowed cross-origin browser caller; never with credentials. */
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  if (origin === null || origin === new URL(request.url).origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
    vary: "Origin",
  };
}

function withHeaders(
  response: Response,
  headers: Record<string, string>,
): Response {
  if (Object.keys(headers).length === 0) return response;
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Response {
  const id =
    isPlainObject(body) &&
    (typeof body["id"] === "string" || typeof body["id"] === "number")
      ? body["id"]
      : null;
  return Response.json(
    { jsonrpc: "2.0", error: { code, message }, id },
    { status, headers },
  );
}
