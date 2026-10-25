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
export { authorizeUrl, type AuthorizeUrlOptions } from "./authorizeUrl.js";
export {
  connectPath,
  connectUrl,
  type ConnectUrlOptions,
} from "./connectUrl.js";
export {
  createGatewayFetch,
  type CreateGatewayFetchOptions,
  type GatewayFetchEnv,
} from "./gatewayFetch.js";
export { ai, AI_DEFAULT_BASE_URL, type AiClient } from "./ai.js";
export {
  GatewayRefusalError,
  gatewayRefusal,
  devAccessTokenName,
  integrationFetch,
  integrationStatus,
  type EmailIntegrationStatus,
  type GatewayRefusal,
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
