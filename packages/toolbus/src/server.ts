/**
 * The MCP server for one request, built on the official SDK's low-level
 * `Server`. The SDK owns the protocol (eras, envelopes, `server/discover`,
 * header rules, error codes); this file only lists and calls tools from the
 * catalog snapshot in the request's view.
 *
 * Tools are the only capability: no resources, prompts or logging, and the
 * tool list never changes mid-request. Whether it may change between
 * requests (`listChanged`) is the HTTP layer's call, per era: see http.ts.
 */
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/server";
import { canonicalJson } from "@every-app/sdk/internal";
import { listBuiltinTools } from "./builtins";
import { executeToolCall } from "./execute";
import { displayedToolName, exposedToolName } from "./names";
import { evaluateToolPolicy } from "./policy";
import type {
  ToolBusApp,
  ToolBusDeps,
  ToolBusTool,
  ToolBusView,
} from "./types";
import { jsonSchemaValidator } from "./validation";

export const TOOLBUS_VERSION = "0.1.0";
/** Clients may cache tools/list this long (2026-07-28 `ttlMs`). */
const TOOLS_LIST_TTL_MS = 60_000;

function byKey<T>(key: (item: T) => string) {
  return (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function toMcpTool(
  view: ToolBusView,
  app: ToolBusApp,
  tool: ToolBusTool,
): Tool {
  // Hints derive from the declared risk; an app can't claim readOnlyHint for
  // a write tool. The spec reads a missing destructiveHint or openWorldHint
  // as true, so both are always spelled out: a write tool isn't destructive
  // (those are hidden until approvals exist), and a tool only reaches beyond
  // its app when its definition says `openWorld`.
  return {
    name: exposedToolName(view, app, tool),
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    ...(tool.outputSchema
      ? { outputSchema: tool.outputSchema as Tool["outputSchema"] }
      : {}),
    annotations: {
      ...tool.annotations,
      readOnlyHint: tool.risk === "read",
      // Only meaningful when readOnlyHint is false.
      ...(tool.risk === "read"
        ? {}
        : { destructiveHint: tool.risk === "destructive" }),
      openWorldHint: tool.annotations?.openWorldHint ?? false,
    },
  };
}

/**
 * The tools this caller may see, in a stable order: on the gateway surface
 * the built-in `everyapp_*` tools first, then by app id, then name. Reads
 * only the snapshot; never calls an app.
 */
export function listTools(view: ToolBusView): Tool[] {
  const tools: Tool[] = view.surface === "gateway" ? listBuiltinTools() : [];
  for (const app of [...view.apps].sort(byKey((item) => item.appId))) {
    for (const tool of [...app.tools].sort(byKey((item) => item.name))) {
      if (evaluateToolPolicy(tool, view.principal).action === "allow") {
        tools.push(toMcpTool(view, app, tool));
      }
    }
  }
  return tools;
}

/**
 * 16 hex characters of SHA-256 over the tools this caller would be listed:
 * names, schemas, descriptions and hints. Equal lists hash equal; a changed
 * one is what `notifications/tools/list_changed` reports.
 */
export async function toolListHash(view: ToolBusView): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(listTools(view))),
  );
  let hex = "";
  for (const byte of new Uint8Array(digest).subarray(0, 8)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function createToolBusServer(
  view: ToolBusView,
  deps: ToolBusDeps,
  protocolVersion?: string,
  options: { listChanged?: boolean } = {},
): Server {
  const server = new Server(
    {
      name: view.serverInfo.name,
      ...(view.serverInfo.title ? { title: view.serverInfo.title } : {}),
      version: TOOLBUS_VERSION,
    },
    {
      capabilities: { tools: { listChanged: options.listChanged ?? false } },
      ...(view.instructions ? { instructions: view.instructions } : {}),
      jsonSchemaValidator,
      cacheHints: {
        "tools/list": { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" },
      },
    },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: listTools(view),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const resolution = await executeToolCall(
      view,
      {
        name: request.params.name,
        arguments: request.params.arguments,
        ...(protocolVersion ? { protocolVersion } : {}),
      },
      deps,
    );
    if (resolution.kind === "unknown_tool") {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${displayedToolName(request.params.name)}`,
      );
    }
    return server.projectCallToolResult(
      resolution.result as CallToolResult,
      resolution.tool.outputSchema,
    );
  });

  return server;
}
