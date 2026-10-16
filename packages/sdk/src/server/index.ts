/**
 * @every-app/sdk/server — the server-side surface.
 *
 * There is intentionally no client-side export.
 */
export {
  ConfigurationError,
  IdentityError,
  everyApp,
  getEveryAppUser,
  hasScope,
  requireEveryAppUser,
  type EveryAppOptions,
  type EveryAppManifestLike,
  type EveryAppHandler,
  type EveryAppUser,
  type IdentityResult,
} from "./everyApp.js";
export {
  createGatewayFetch,
  type CreateGatewayFetchOptions,
  type GatewayFetchEnv,
} from "./gatewayFetch.js";
export {
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
  type GatewayRefusal,
  type IntegrationFetchOptions,
  type IntegrationStatus,
} from "./integrationFetch.js";
export type { CapabilityId } from "../internal/index.js";
export {
  // Deprecated in 0.3.0 and removed in 0.4.0: use defineTools().
  createMcpHandler,
  type CreateMcpHandlerOptions,
  type McpRequestHandler,
  type McpToolContext,
  type McpToolDefinition,
} from "./mcp.js";
export {
  ToolError,
  defineTools,
  toolResult,
  type DefineToolsOptions,
  type PlainToolSchema,
  type StandardSchemaWithJSON,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  type ToolSchema,
  type ToolSet,
} from "./tools.js";
export type { ToolRisk } from "../internal/index.js";
