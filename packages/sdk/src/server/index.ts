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
export { AttributionError, type GatewayCallFor } from "./attribution.js";
export {
  createGatewayFetch,
  type CreateGatewayFetchOptions,
  type GatewayFetchEnv,
} from "./gatewayFetch.js";
export {
  GatewayRefusalError,
  gatewayRefusal,
  integrationFetch,
  integrationStatus,
  type EmailIntegrationStatus,
  type GatewayRefusal,
  type IntegrationFetchOptions,
  type IntegrationStatus,
  type IntegrationStatusOf,
} from "./integrationFetch.js";
export {
  nodeServerHandler,
  type NodeServer,
  type NodeServerHandlerOptions,
} from "./nodeServer.js";
export { sendEmail, type SendEmailOptions } from "./sendEmail.js";
export type {
  ApiKeyCapabilityId,
  CapabilityId,
  EmailAddressInput,
  EmailAttachmentInput,
  SendEmailMessage,
  SendEmailResult,
} from "../internal/index.js";
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
