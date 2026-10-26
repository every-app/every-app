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
  isAdmin,
  requireCurrentUser,
  requireEveryAppUser,
  type EveryAppOptions,
  type EveryAppManifestLike,
  type EveryAppHandler,
  type EveryAppUser,
  type IdentityResult,
  type OrgRole,
} from "./everyApp.js";
export {
  OrganizationMismatchError,
  RequestContextError,
  currentUser,
  withOrganization,
} from "./context.js";
export { AttributionError, type GatewayCallFor } from "./attribution.js";
export { gatewayUrl } from "./gatewayUrl.js";
export type { EveryAppEnv } from "./env.js";
/** The header a Gateway refusal carries its code in; `gatewayRefusal()` reads the rest. */
export { GATEWAY_ERROR_HEADER } from "../internal/protocol.js";
export { authorizeUrl, type AuthorizeUrlOptions } from "./authorizeUrl.js";
export {
  connectPath,
  connectUrl,
  type ConnectUrlOptions,
} from "./connectUrl.js";
export {
  createGatewayFetch,
  type CreateGatewayFetchOptions,
} from "./gatewayFetch.js";
export {
  ai,
  aiBaseUrl,
  aiStatus,
  providerBaseUrl,
  AI_DEFAULT_BASE_URL,
  type AiClient,
  type AiStatus,
} from "./ai.js";
export {
  AI_NOT_CONFIGURED_CODES,
  GatewayRefusalError,
  gatewayRefusal,
  isAiNotConfigured,
  refusalFromError,
  type GatewayRefusal,
  type SetupInfo,
} from "./refusal.js";
export {
  devAccessTokenName,
  integrationFetch,
  integrationStatus,
  type EmailIntegrationStatus,
  type IntegrationFetchOptions,
  type IntegrationStatus,
  type IntegrationStatusOf,
  type OAuthClientIntegrationStatus,
} from "./integrationFetch.js";
export {
  nodeServerHandler,
  type NodeServer,
  type NodeServerHandlerOptions,
} from "./nodeServer.js";
export { sendEmail, type SendEmailOptions } from "./sendEmail.js";
export { gatewayAiBinding, type GatewayAiBindingOptions } from "./aiBinding.js";
export {
  gatewayEmailBinding,
  type GatewayEmailBindingMessage,
  type GatewayEmailBindingOptions,
} from "./emailBinding.js";
export { listMembers, type ListMembersOptions } from "./listMembers.js";
export { emit, type EmitOptions } from "./emit.js";
export type {
  ApiKeyCapabilityId,
  CapabilityId,
  OAuthClientCapabilityId,
  ConnectionAccount,
  EmailAddressInput,
  EmailAttachmentInput,
  SendEmailMessage,
  SendEmailResult,
  ListMembersResult,
  OrganizationMember,
  OrganizationMemberRole,
  EmitEventResult,
} from "../internal/index.js";
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
export {
  fromMcpTools,
  type FromMcpToolsOptions,
  type McpToolAnnotationsLike,
  type McpToolLike,
  type McpToolResultLike,
  type McpToolSchemaLike,
} from "./fromMcpTools.js";
