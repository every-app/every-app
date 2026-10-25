/**
 * @every-app/toolbus — the gateway's MCP server, driven by app tool catalogs.
 *
 * Apps describe tools with the SDK's `defineTools()`; the gateway snapshots
 * each catalog at deploy and serves MCP clients from the snapshots: tools/list
 * never calls an app, and tools/call makes exactly one call over the app's
 * service binding with an identity minted for that call. One app is served
 * on its own host (`appSurfaceView`); every app the caller reaches, plus the
 * built-in `everyapp_*` tools, on the gateway (`gatewaySurfaceView`).
 */
export {
  BUILTIN_APP_ID,
  SEARCH_RESULT_MAX_BYTES,
  builtinToolKind,
  listBuiltinTools,
  type BuiltinKind,
  type ListingMode,
} from "./builtins";
export {
  CATALOG_LIMITS,
  fetchAppCatalog,
  normalizeCatalog,
  type CatalogSnapshot,
  type FetchCatalogOptions,
} from "./catalog";
export { createArgumentsDigester } from "./digest";
export {
  executeToolCall,
  MAX_RESULT_BYTES,
  type ToolCallRequest,
  type ToolCallResolution,
} from "./execute";
export {
  APP_LISTEN_MAX_MS,
  createToolBusHttp,
  GATEWAY_LISTEN_MAX_MS,
  MAX_REQUEST_BODY_BYTES,
  type ToolBusHttpHandler,
} from "./http";
export { MCP_APP_TOOLS } from "./mcpApps";
export {
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  splitNamespacedToolName,
} from "./names";
export {
  evaluateToolPolicy,
  roleReaches,
  type ToolPolicyDecision,
} from "./policy";
export {
  principalFromSession,
  type PrincipalResolution,
  type SessionLike,
} from "./principal";
export {
  CALL_MAX_BYTES,
  CALL_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MAX_LIST_PAGES,
  normalizeRemoteCatalog,
  RemoteMcpClient,
  RemoteMcpError,
  riskHintOf,
  type NormalizedRemoteCatalog,
  type RemoteMcpClientOptions,
  type RemoteMcpErrorKind,
  type RemoteToolRecord,
  type RiskHint,
  type UpstreamCallResult,
  type UpstreamListing,
  type UpstreamTool,
} from "./remote";
export { listTools, TOOLBUS_VERSION } from "./server";
export { ViewRefusedError } from "./types";
export {
  FULL_LISTING_MAX_BYTES,
  FULL_LISTING_MAX_TOOLS,
  appSurfaceView,
  gatewaySurfaceView,
} from "./view";
export type {
  JsonObject,
  McpAccess,
  McpPrincipal,
  ToolBusApp,
  ToolBusDeps,
  ToolBusSigning,
  ToolBusTool,
  ToolBusView,
  ToolCallAuditEvent,
  ToolCallOutcome,
  UnavailableApp,
  WorkspaceHost,
  WorkspaceRole,
} from "./types";
export {
  ACTIVITY_TIME_MAX_MS,
  WORKSPACE_ACTIVITY_PAGE_MAX,
  WORKSPACE_TOOLS,
  type WorkspaceToolDefinition,
} from "./workspace";
export { PROVIDER_TOOLS } from "./providers";
