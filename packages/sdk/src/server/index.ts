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
  createMcpHandler,
  type CreateMcpHandlerOptions,
  type McpToolContext,
  type McpToolDefinition,
  type McpRequestHandler,
} from "./mcp.js";
