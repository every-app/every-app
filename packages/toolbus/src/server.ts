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
import { listBuiltinTools, type BuiltinHostOptions } from "./builtins";
import { executeToolCall } from "./execute";
import { isPlainObject } from "./io";
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
/** How much of a client's name and version the audit row keeps. */
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_CLIENT_VERSION_LENGTH = 50;
/** The whole description (both parts and a space fit well inside it). */
export const MAX_CLIENT_INFO_LENGTH = 200;

/**
 * One line of visible text from a value a client sent: control and format
 * characters removed (a bidi override or a zero-width character would let
 * a client dress its name up on the Activity page), whitespace collapsed,
 * cut to `max` characters. Empty for anything that isn't a string.
 */
export function cleanClientText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const visible = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(visible).slice(0, max).join("").trim();
}

/**
 * The client's description of itself for the audit row, `<name> <version>`,
 * from the `Implementation` it sent in the handshake (the 2026-07-28
 * envelope's `clientInfo`, or a 2025 `initialize`'s). Never verified: a
 * client calls itself what it likes, so the text is only cleaned and
 * bounded. Undefined when there is no name.
 */
export function describeClient(implementation: unknown): string | undefined {
  if (!isPlainObject(implementation)) return undefined;
  const name = cleanClientText(implementation["name"], MAX_CLIENT_NAME_LENGTH);
  if (!name) return undefined;
  const version = cleanClientText(
    implementation["version"],
    MAX_CLIENT_VERSION_LENGTH,
  );
  return version ? `${name} ${version}` : name;
}

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
 * the built-in `everyapp_*` tools its listing mode shows first (the
 * workspace tools among them only when the host runs them, `host.workspace`,
 * and only to a caller whose role reaches each), then by app id, then
 * name; in compact mode the built-ins alone, the apps' tools being found
 * with `everyapp_search_tools` and run through the wrappers. Reads only
 * the snapshot; never calls an app.
 */
export function listTools(
  view: ToolBusView,
  host: BuiltinHostOptions = {},
): Tool[] {
  const tools: Tool[] =
    view.surface === "gateway" ? listBuiltinTools(view, host) : [];
  if (view.surface === "gateway" && view.listing === "compact") return tools;
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
 * one is what `notifications/tools/list_changed` reports. Computed from the
 * listed tools, so a change of listing mode reads as a list change too.
 */
export async function toolListHash(
  view: ToolBusView,
  host: BuiltinHostOptions = {},
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(listTools(view, host))),
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
  options: {
    listChanged?: boolean;
    /**
     * The client as a 2025 session carries it (`describeClient` of the
     * `initialize` it was minted for), for calls whose request names none.
     */
    clientInfo?: string;
  } = {},
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
    tools: listTools(view, {
      workspace: deps.workspace !== undefined,
      providers: deps.workspace?.providers === true,
    }),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    // Who the client says it is. A 2026-07-28 request carries it in its
    // envelope, which the SDK writes onto the server before the handler
    // runs (it deprecates this accessor for the handler context's
    // `envelope`, whose type is empty in 2.3.1); a 2025 client said it
    // once at initialize, and only its session carries it here.
    const clientInfo =
      describeClient(server.getClientVersion()) ?? options.clientInfo;
    const resolution = await executeToolCall(
      view,
      {
        name: request.params.name,
        arguments: request.params.arguments,
        ...(protocolVersion ? { protocolVersion } : {}),
        ...(clientInfo ? { clientInfo } : {}),
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
