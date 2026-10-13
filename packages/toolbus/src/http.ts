/**
 * HTTP serving for the ToolBus: one stateless handler for both MCP eras.
 *
 *  - 2026-07-28 traffic (a per-request `_meta` envelope) goes to the SDK's
 *    own `createMcpHandler`: strict, JSON responses, no subscriptions.
 *  - 2025-06-18 / 2025-11-25 traffic (the initialize handshake and requests
 *    without the envelope) gets a fresh JSON-mode Streamable HTTP transport
 *    per request, closed before the response returns. No sessions.
 *
 * First it checks Origin (and, in local dev, Host) as the Streamable HTTP
 * spec requires: a browser may call from the endpoint's own origin, and in
 * local dev from any localhost origin (MCP Inspector), whose CORS preflights
 * it answers. On an app host the perimeter authenticates every request
 * first, so a cross-origin preflight (which carries no credentials) never
 * gets here.
 */
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHttpHandler,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { scopesForAccess } from "./execute";
import { isPlainObject } from "./io";
import { createToolBusServer } from "./server";
import type { ToolBusDeps, ToolBusView } from "./types";

export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const VIEW_KEY = "everyapp.toolbus.view";
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
  // Built on first use: the SDK logs a notice whenever a JSON-mode handler
  // is created, which only belongs in logs that actually serve MCP.
  let modern: McpHttpHandler | undefined;
  const modernHandler = () =>
    (modern ??= createMcpHandler(
      (context) =>
        createToolBusServer(
          viewOf(context),
          deps,
          context.requestInfo?.headers.get("mcp-protocol-version") ?? undefined,
        ),
      {
        legacy: "reject",
        responseMode: "json",
        maxSubscriptions: 0,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      },
    ));

  return async (request, view) => {
    const refused = refuseUntrusted(request, deps);
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
    if (
      Number(request.headers.get("content-length")) > MAX_REQUEST_BODY_BYTES
    ) {
      return withHeaders(
        jsonRpcError(413, -32600, "Request body too large."),
        cors,
      );
    }

    const authInfo: AuthInfo = {
      token: "toolbus",
      clientId: view.principal.credential.id,
      scopes: scopesForAccess(view.principal.access),
      extra: { [VIEW_KEY]: view },
    };
    // Options go in the third argument; the second is a pre-parsed body.
    const legacy = await isLegacyRequest(request, undefined, {
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    });
    const response = legacy
      ? await serveLegacy(request, view, deps, authInfo)
      : await modernHandler().fetch(request, { authInfo });
    return withHeaders(response, cors);
  };
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
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    body = undefined;
  }
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

  const server = createToolBusServer(
    view,
    deps,
    request.headers.get("mcp-protocol-version") ?? undefined,
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request, {
      authInfo,
      ...(body !== undefined ? { parsedBody: body } : {}),
    });
  } finally {
    await Promise.all([
      transport.close().catch(() => undefined),
      server.close().catch(() => undefined),
    ]);
  }
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

function refuseUntrusted(request: Request, deps: ToolBusDeps): Response | null {
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
  if (origin === null || originAllowed(origin, request, deps)) return null;
  return jsonRpcError(403, -32000, "Forbidden: origin not allowed.");
}

function originAllowed(
  origin: string,
  request: Request,
  deps: ToolBusDeps,
): boolean {
  if (origin === new URL(request.url).origin) return true;
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
    "access-control-expose-headers": "mcp-protocol-version",
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
