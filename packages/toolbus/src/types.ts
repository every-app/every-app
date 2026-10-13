/**
 * The ToolBus's view of the world: snapshotted app catalogs, the caller, and
 * the seams for reaching apps. Free of D1, Better Auth and MCP types, so the
 * gateway, `everyapp dev` and tests each supply their own.
 */
import type { ToolRisk } from "@every-app/sdk/internal";

export type JsonObject = Record<string, unknown>;

/** One snapshotted tool (an `app_tools` row). */
export interface ToolBusTool {
  /** Local name, e.g. `create_todo`. */
  name: string;
  title?: string;
  description: string;
  risk: ToolRisk;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  annotations?: { idempotentHint?: boolean; openWorldHint?: boolean };
}

/** One app's catalog, as the ToolBus serves it. */
export interface ToolBusApp {
  /** The gateway's row id (`apps.id`), for the audit line. */
  rowId: string;
  /** Manifest id: the identity audience and the tool-name prefix. */
  appId: string;
  name: string;
  /** What the app is for, as `everyapp_list_apps` tells it. */
  description?: string;
  /** Origin the tools contract is called under, e.g. `https://todo-acme.example.com`. */
  baseUrl: string;
  catalogHash: string;
  instructions?: string;
  tools: ToolBusTool[];
}

export type McpAccess = "read" | "write";

/** Who is calling, as the host (gateway or `everyapp dev`) resolved it. */
export interface McpPrincipal {
  userId: string;
  email: string;
  organizationId: string;
  /** For `everyapp_whoami` and the gateway's server title. */
  organizationName?: string;
  orgRole: string;
  /**
   * How the caller authenticated. `id` is a PAT id or an OAuth connection
   * id, never a secret; `clientName` is the connected AI app's own name
   * (self-asserted unless its client id is a verified domain), for display.
   */
  credential: {
    kind: "pat" | "session" | "dev" | "oauth";
    id: string;
    clientName?: string;
  };
  access: McpAccess;
}

/**
 * One request's view: the caller and the apps it may reach. The "app"
 * surface serves one app under local tool names (`<app-host>/mcp`); the
 * "gateway" surface serves several under `<appId>_<tool>` names.
 */
export interface ToolBusView {
  surface: "app" | "gateway";
  principal: McpPrincipal;
  apps: ToolBusApp[];
  /** What initialize and server/discover report. */
  serverInfo: { name: string; title?: string };
  instructions?: string;
  /** Correlates the audit line with the edge request (cf-ray). */
  requestId?: string;
  /**
   * Cross-origin browser callers allowed besides the endpoint's own origin
   * (e.g. MCP Inspector's `http://localhost:6274`), as exact origins.
   */
  allowedOrigins?: readonly string[];
}

export type ToolCallOutcome =
  | "ok"
  | "tool_error"
  | "invalid_arguments"
  | "app_error"
  | "timeout"
  | "unreachable"
  | "not_run";

/** One per `tools/call`, allowed or not. Never carries raw arguments. */
export interface ToolCallAuditEvent {
  surface: ToolBusView["surface"];
  /** The name the client called. */
  tool: string;
  appId?: string;
  appRowId?: string;
  risk?: ToolRisk;
  decision: "allowed" | "blocked";
  reason?: string;
  outcome: ToolCallOutcome;
  durationMs: number;
  callId: string;
  argsDigest?: string;
  resultBytes?: number;
  protocolVersion?: string;
  requestId?: string;
  userId: string;
  organizationId: string;
  credentialKind: McpPrincipal["credential"]["kind"];
  credentialId: string;
  /** The connected AI app's display name, when the credential has one. */
  clientName?: string;
}

/** Signing material for the tokens the ToolBus mints for app calls. */
export interface ToolBusSigning {
  privateKeyPem: string;
  /** The gateway URL (the `iss` apps verify). */
  issuer: string;
  /** Header kid; local dev mints with the dev kid. */
  keyId?: string;
}

export interface ToolBusDeps {
  signing: ToolBusSigning;
  /** Send a request to the app's Worker (service binding; vite in dev). */
  invokeApp(app: ToolBusApp, request: Request): Promise<Response>;
  /** The app reported another catalog, or doesn't know a catalog tool. */
  onCatalogDrift?(app: ToolBusApp): void;
  audit?(event: ToolCallAuditEvent): void;
  /** Keyed digest of the arguments for the audit event. */
  digestArguments?(args: unknown): Promise<string>;
  /**
   * Local dev only: the Host must be localhost-class (DNS rebinding), and any
   * localhost-class Origin may call (MCP Inspector). Otherwise a browser may
   * call only from the endpoint's own origin.
   */
  localhostOnly?: boolean;
  /** How long an app may take to answer one call. Default 30 s. */
  callTimeoutMs?: number;
}
