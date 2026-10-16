/** Shared fixtures for the ToolBus tests. Never imported by runtime code. */
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";
import type {
  McpPrincipal,
  ToolBusApp,
  ToolBusTool,
  ToolBusView,
} from "./types";
import { appSurfaceView, gatewaySurfaceView } from "./view";

export const ISSUER = "https://home.example.com";

export async function testKeys(): Promise<{
  privateKeyPem: string;
  publicKeyPem: string;
}> {
  const keys = await generateKeyPair("RS256", { extractable: true });
  return {
    privateKeyPem: await exportPKCS8(keys.privateKey),
    publicKeyPem: await exportSPKI(keys.publicKey),
  };
}

export const PRINCIPAL: McpPrincipal = {
  userId: "user_1",
  email: "user@example.com",
  organizationId: "org_1",
  orgRole: "member",
  credential: { kind: "pat", id: "pat_1" },
  access: "write",
};

const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = [],
) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

function todoTools(): ToolBusTool[] {
  return [
    {
      name: "list_todos",
      description: "List todos.",
      risk: "read",
      inputSchema: objectSchema(),
    },
    {
      name: "create_todo",
      title: "Create todo",
      description: "Create a todo.",
      risk: "write",
      inputSchema: objectSchema({ title: { type: "string", minLength: 1 } }, [
        "title",
      ]),
      annotations: { idempotentHint: false },
    },
    {
      name: "delete_todo",
      description: "Delete a todo.",
      risk: "destructive",
      inputSchema: objectSchema({ id: { type: "string" } }, ["id"]),
    },
  ];
}

export function todoApp(overrides: Partial<ToolBusApp> = {}): ToolBusApp {
  return {
    rowId: "row_todo",
    appId: "todo",
    audience: "every-acme-todo",
    name: "Todos",
    baseUrl: "https://todo-acme.example.com",
    catalogHash: `sha256:${"a".repeat(64)}`,
    instructions: "Call list_todos first.",
    tools: todoTools(),
    ...overrides,
  };
}

export function appView(
  app: ToolBusApp = todoApp(),
  principal: McpPrincipal = PRINCIPAL,
): ToolBusView {
  return appSurfaceView(app, principal, "ray_1");
}

export function gatewayView(
  apps: ToolBusApp[],
  principal: McpPrincipal = PRINCIPAL,
  allowedOrigins?: readonly string[],
): ToolBusView {
  return gatewaySurfaceView(principal, apps, {
    requestId: "ray_1",
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

let nextId = 1;

/** A 2026-07-28 request: envelope in `_meta`, routing headers set. */
export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  url = "https://todo-acme.example.com/mcp",
): Request {
  const name = typeof params["name"] === "string" ? params["name"] : undefined;
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: { ...params, _meta: MODERN_META },
    }),
  });
}

/** A 2025-era request: no envelope; the version header after initialize. */
export function legacyRequest(
  method: string,
  params: Record<string, unknown> | undefined,
  options: {
    version?: string;
    headers?: Record<string, string>;
    notification?: boolean;
    url?: string;
  } = {},
): Request {
  const version = options.version ?? "2025-11-25";
  return new Request(options.url ?? "https://todo-acme.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(method === "initialize" ? {} : { "mcp-protocol-version": version }),
      ...options.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(options.notification ? {} : { id: nextId++ }),
      method,
      ...(params ? { params } : {}),
    }),
  });
}

/** The JSON-RPC message in a ToolBus response. */
export async function rpcBody(response: Response): Promise<any> {
  return response.json();
}
