/**
 * `createMcpHandler()` — a stateless Streamable HTTP MCP server handler.
 *
 *   const mcp = createMcpHandler({
 *     name: "my-app",
 *     tools: {
 *       list_items: {
 *         description: "List the user's items",
 *         inputSchema: { type: "object", properties: { limit: { type: "number" } } },
 *         handler: async (args, { user, env }) => listItems(user.id, args.limit),
 *       },
 *     },
 *   });
 *   export default everyApp((request, env, ctx, user) => {
 *     if (new URL(request.url).pathname === "/mcp") return mcp(request, env, ctx, user);
 *     ...
 *   }, manifest);
 *
 * The gateway authenticates the caller and injects the identity JWT; this
 * handler only consumes the verified `EveryAppUser`. Each POST carries one
 * self-contained JSON-RPC message (no sessions, no SSE), so any isolate can
 * serve any request.
 */
import type { EveryAppUser } from "../internal/index.js";
import {
  getEveryAppUser,
  hasScope,
  type ExecutionContextLike,
} from "./everyApp.js";

/** Protocol revisions this handler accepts; initialize echoes the client's when supported. */
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
] as const;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export interface McpToolContext<TEnv = Record<string, unknown>> {
  user: EveryAppUser;
  env: TEnv;
  request: Request;
  ctx: ExecutionContextLike;
}

export interface McpToolDefinition<TEnv = Record<string, unknown>> {
  description?: string;
  /** JSON Schema for the tool's arguments. Defaults to an empty object schema. */
  inputSchema?: Record<string, unknown>;
  /**
   * Scope required to list or call this tool, checked against the scopes the
   * credential was granted (`user.scopes`). Omit to allow any authenticated user.
   */
  scope?: string;
  /**
   * Tool implementation. Return a string or JSON-serializable value (wrapped as
   * text content), or a full `{ content: [...] }` result. Thrown errors become
   * `isError: true` tool results, not protocol errors.
   */
  handler: (
    args: Record<string, unknown>,
    context: McpToolContext<TEnv>,
  ) => unknown;
}

export interface CreateMcpHandlerOptions<TEnv = Record<string, unknown>> {
  /** Server name reported to MCP clients. */
  name: string;
  version?: string;
  /** Optional usage hints surfaced to clients after initialize. */
  instructions?: string;
  /**
   * Browser origins allowed to call this endpoint, in addition to the
   * endpoint's own origin. Non-browser clients send no Origin header and are
   * unaffected; any other present Origin is rejected with 403 (the Streamable
   * HTTP spec's DNS-rebinding defense).
   */
  allowedOrigins?: string[];
  tools: Record<string, McpToolDefinition<TEnv>>;
}

/** Matches the everyApp() handler signature so it can be delegated to directly. */
export type McpRequestHandler<TEnv = Record<string, unknown>> = (
  request: Request,
  env: TEnv,
  ctx: ExecutionContextLike,
  user?: EveryAppUser | null,
) => Promise<Response>;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function userHasScope(user: EveryAppUser, scope: string | undefined): boolean {
  return !scope || hasScope(user, scope);
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function accepted(): Response {
  return new Response(null, { status: 202 });
}

function toCallToolResult(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  ) {
    return value as Record<string, unknown>;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text }] };
}

function negotiateProtocolVersion(params: unknown): string {
  const requested =
    params && typeof params === "object"
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;
}

export function createMcpHandler<TEnv = Record<string, unknown>>(
  options: CreateMcpHandlerOptions<TEnv>,
): McpRequestHandler<TEnv> {
  const {
    name,
    version = "0.0.0",
    instructions,
    allowedOrigins = [],
    tools,
  } = options;

  return async (request, env, ctx, user) => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }

    const origin = request.headers.get("origin");
    if (
      origin &&
      origin !== new URL(request.url).origin &&
      !allowedOrigins.includes(origin)
    ) {
      return Response.json({ error: "forbidden_origin" }, { status: 403 });
    }

    const resolvedUser =
      user !== undefined ? user : await getEveryAppUser(request, env as object);
    if (!resolvedUser) {
      return Response.json(
        { error: "unauthenticated", message: "MCP requests require a user" },
        { status: 401 },
      );
    }

    const versionHeader = request.headers.get("mcp-protocol-version");
    if (
      versionHeader &&
      !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
        versionHeader,
      )
    ) {
      return Response.json(
        {
          error: "unsupported_protocol_version",
          supported: SUPPORTED_PROTOCOL_VERSIONS,
        },
        { status: 400 },
      );
    }

    let message: JsonRpcMessage;
    try {
      message = (await request.json()) as JsonRpcMessage;
    } catch {
      return jsonRpcError(null, -32700, "parse error: body must be JSON");
    }
    if (Array.isArray(message)) {
      return jsonRpcError(null, -32600, "batch requests are not supported");
    }
    if (message === null || typeof message !== "object") {
      return jsonRpcError(null, -32600, "invalid JSON-RPC message");
    }
    if (message.jsonrpc !== "2.0") {
      return jsonRpcError(null, -32600, 'jsonrpc must be "2.0"');
    }
    if (
      "id" in message &&
      typeof message.id !== "string" &&
      typeof message.id !== "number" &&
      message.id !== null
    ) {
      return jsonRpcError(null, -32600, "id must be a string, number, or null");
    }

    // Notifications and client-side responses expect no reply body.
    if (typeof message.method !== "string") return accepted();
    if (!("id" in message)) return accepted();

    const id = message.id;
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: negotiateProtocolVersion(message.params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });

      case "ping":
        return jsonRpcResult(id, {});

      case "tools/list": {
        const visible = Object.entries(tools)
          .filter(([, tool]) => userHasScope(resolvedUser, tool.scope))
          .map(([toolName, tool]) => ({
            name: toolName,
            ...(tool.description ? { description: tool.description } : {}),
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          }));
        return jsonRpcResult(id, { tools: visible });
      }

      case "tools/call": {
        const params =
          message.params && typeof message.params === "object"
            ? (message.params as { name?: unknown; arguments?: unknown })
            : {};
        const toolName = typeof params.name === "string" ? params.name : "";
        const tool = tools[toolName];
        if (!tool) {
          return jsonRpcError(id, -32602, `unknown tool: ${toolName}`);
        }
        if (!userHasScope(resolvedUser, tool.scope)) {
          return jsonRpcError(
            id,
            -32602,
            `tool ${toolName} requires scope ${tool.scope}`,
          );
        }
        const args =
          params.arguments && typeof params.arguments === "object"
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const value = await tool.handler(args, {
            user: resolvedUser,
            env,
            request,
            ctx,
          });
          return jsonRpcResult(id, toCallToolResult(value));
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          return jsonRpcResult(id, {
            content: [{ type: "text", text }],
            isError: true,
          });
        }
      }

      default:
        return jsonRpcError(id, -32601, `method not found: ${message.method}`);
    }
  };
}
