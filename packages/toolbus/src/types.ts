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
  /** Manifest id: the tool-name prefix. */
  appId: string;
  /**
   * The `aud` of every token minted for the app: its Worker name (the app
   * id under `everyapp dev`, whose Workers expect that).
   */
  audience: string;
  name: string;
  /** What the app is for, as `everyapp_list_apps` tells it. */
  description?: string;
  /** Origin the tools contract is called under, e.g. `https://todo-acme.example.com`. */
  baseUrl: string;
  catalogHash: string;
  instructions?: string;
  tools: ToolBusTool[];
}

/**
 * An app the caller reaches whose tools aren't served right now, and why
 * (it needs setup): named in the gateway's instructions and by
 * `everyapp_list_apps`, so a connected client can say what to do.
 */
export interface UnavailableApp {
  appId: string;
  name: string;
  /** Plain words for the client's user, e.g. the command an admin runs. */
  reason: string;
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
   * How the caller authenticated. `id` is a PAT id, an OAuth connection id
   * or, for `access` (a verified Cloudflare Access assertion on the
   * gateway's /mcp), the Access email: never a secret. `clientName` is the
   * connected AI app's own name (self-asserted unless its client id is a
   * verified domain), for display.
   */
  credential: {
    kind: "pat" | "session" | "dev" | "oauth" | "access";
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
  /** Gateway surface: the apps left out of `apps` because they need setup. */
  unavailable?: UnavailableApp[];
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
  /**
   * Read the caller's view again, from the current catalogs. A held
   * 2026-07-28 `subscriptions/listen` stream polls it to push
   * `notifications/tools/list_changed`; without it the modern era declares
   * `listChanged: false` and no stream is held. Throw `ViewRefusedError`
   * when the caller no longer stands: the stream ends at that poll. Any
   * other error is taken as transient (the catalogs couldn't be read just
   * now): the stream stays open, pushes nothing, and ends only when three
   * polls in a row fail.
   */
  refresh?: () => Promise<ToolBusView>;
  /**
   * When the credential behind the request expires, in milliseconds since
   * the epoch: a held stream ends gracefully no later than this, so it
   * never outlives the token that opened it.
   */
  listenUntil?: number;
  /**
   * Gateway surface: how `tools/list` presents the apps' tools. `"full"`
   * lists every tool the policy allows under its own `<app>_<tool>` name;
   * `"compact"` lists only the built-ins, and the apps' tools are found
   * with `everyapp_search_tools` and run through `everyapp_call_read` or
   * `everyapp_call_write`. Set by `gatewaySurfaceView`: the caller's
   * explicit choice (the `X-EveryApp-Tools` header or `?tools=` on `/mcp`),
   * else compact once a full listing would pass `FULL_LISTING_MAX_TOOLS`
   * entries or `FULL_LISTING_MAX_BYTES`. The app surface is always full.
   */
  listing?: "full" | "compact";
}

/**
 * Thrown by `ToolBusView.refresh` when the caller no longer stands (a
 * revoked connection or token, a removed or deactivated member, a suspended
 * organization): a held stream ends at once, where any other error only
 * counts as a failed poll.
 */
export class ViewRefusedError extends Error {
  override readonly name = "ViewRefusedError";
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
  /**
   * The client's own description of itself from the MCP handshake, as
   * `<name> <version>`: the 2026-07-28 per-request `clientInfo`, or the
   * 2025 `initialize` one carried in the session id. At most 200
   * characters, never verified.
   */
  clientInfo?: string;
  /**
   * The wrapper built-in the call came through (`everyapp_call_read` or
   * `everyapp_call_write`), when it did: `tool` is then the inner tool,
   * and this is the row's only trace of the wrapper.
   */
  via?: string;
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
  /** How often a held `subscriptions/listen` stream re-reads the view. Default 30 s. */
  listenPollMs?: number;
  /** How long a `subscriptions/listen` stream is held before it ends gracefully. Default 10 min. */
  listenMaxMs?: number;
}
