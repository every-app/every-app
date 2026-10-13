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
  createToolBusHttp,
  MAX_REQUEST_BODY_BYTES,
  type ToolBusHttpHandler,
} from "./http";
export {
  MAX_TOOL_NAME_LENGTH,
  namespacedToolName,
  splitNamespacedToolName,
} from "./names";
export { evaluateToolPolicy, type ToolPolicyDecision } from "./policy";
export {
  principalFromSession,
  type PrincipalResolution,
  type SessionLike,
} from "./principal";
export { listTools, TOOLBUS_VERSION } from "./server";
export { appSurfaceView, gatewaySurfaceView } from "./view";
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
} from "./types";
