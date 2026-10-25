const GATEWAY_ERROR_CODES = [
  "UNAUTHORIZED",
  "ORIGIN_NOT_ALLOWED",
  "REQUEST_EXPIRED",
  "ACCESS_DENIED",
  "ORGANIZATION_SUSPENDED",
] as const;

type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

const PUBLIC_ERROR_CODES = [
  "INTERNAL_ERROR",
  "INVALID_INPUT",
  "RATE_LIMITED",
  "AUTH_UNAUTHORIZED",
  "OWNER_ALREADY_EXISTS",
  "ACCOUNT_CREATION_FAILED",
  "USER_NOT_FOUND",
  "USER_ALREADY_EXISTS",
  "CANNOT_DELETE_SELF",
  "CANNOT_DELETE_OWNER",
  "INVITATION_TOKEN_INVALID",
  "INVITATION_TOKEN_EXPIRED",
  "INVITATION_EMAIL_MISMATCH",
  "INVITATION_REQUIRES_PENDING_USER",
  "INVITATION_NOT_FOUND",
  "ALREADY_INVITED",
  "ALREADY_MEMBER",
  "INVITATION_LIMIT_REACHED",
  "INVALID_ORGANIZATION_NAME",
  "EMAIL_NOT_CONFIGURED",
  "EMAIL_DELIVERY_FAILED",
  "RESET_TOKEN_INVALID",
  "RESET_TOKEN_EXPIRED",
  "PASSWORD_RESET_REQUIRES_ACTIVE_USER",
  "APP_NOT_FOUND",
  "APP_ID_ALREADY_EXISTS",
  "TOKEN_NOT_FOUND",
  "INVALID_TOKEN_SCOPE",
  "TOKEN_SCOPE_REQUIRED",
  "TOKEN_SCOPE_LIMIT_EXCEEDED",
  "INVALID_EXPIRATION_DATE",
  "EXPIRATION_IN_PAST",
  "OAUTH_DISABLED",
  "CONNECTION_NOT_FOUND",
  "CANNOT_MANAGE_SELF",
  "CANNOT_MANAGE_OWNER",
  "OWNER_REQUIRED",
  "LAST_OWNER",
  "USER_IN_OTHER_ORGANIZATION",
  "PASSWORD_SIGN_IN_DISABLED",
  "ACCOUNT_ACTIONS_UNAVAILABLE",
  "EMAIL_NOT_VERIFIED",
  "SHARED_APP_ACCESS",
  "DEPLOY_KEYS_UNAVAILABLE",
  "GROUP_NOT_FOUND",
  "GROUP_NAME_TAKEN",
  "EVENT_TARGET_REFUSED",
  "EVENT_SUBSCRIPTIONS_LIMIT",
  "EVENT_SUBSCRIPTION_NOT_FOUND",
  "EVENT_DELIVERY_NOT_FOUND",
  "EVENT_TYPE_UNKNOWN",
  "EVENT_SECRET_INVALID",
  "EVENT_SINK_CONFLICT",
  // The MCP app registry rules (@every-app/perimeter/registry
  // remoteMcpApps.ts): their messages are the rules' own sentences.
  "REMOTE_MCP_INVALID",
  "REMOTE_MCP_URL_REFUSED",
  "REMOTE_MCP_EXISTS",
  "REMOTE_MCP_SECRET_TAKEN",
  "APP_TIER_MISMATCH",
  // OAuth providers (server/oauth/service.ts): the registry rules' codes
  // (their messages are the rules' own sentences) and the flow's.
  "PROVIDER_NOT_FOUND",
  "PROVIDER_SPEC_INVALID",
  "PROVIDER_EXISTS",
  "PROVIDER_BUILTIN",
  "PROVIDER_SECRET_TAKEN",
  "PROVIDER_HOST_REFUSED",
  "PROVIDER_IN_USE",
  "PROVIDER_BOUND",
  "PROVIDER_HOSTED",
  "OAUTH_PROVIDER_REQUIRED",
  "OAUTH_CLIENT_REQUIRED",
  "SEALING_UNAVAILABLE",
  "ADMIN_REQUIRED",
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

const GATEWAY_ERROR_CODE_SET = new Set<string>(GATEWAY_ERROR_CODES);
const PUBLIC_ERROR_CODE_SET = new Set<string>(PUBLIC_ERROR_CODES);

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
  }
}

export class PublicError extends Error {
  readonly code: PublicErrorCode;

  constructor(code: PublicErrorCode, message: string = code) {
    super(message);
    this.name = "PublicError";
    this.code = code;
  }
}

export function getGatewayErrorCode(error: unknown): GatewayErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return null;
  }

  if (!GATEWAY_ERROR_CODE_SET.has(code)) {
    return null;
  }

  return code as GatewayErrorCode;
}

export function getPublicErrorCode(error: unknown): PublicErrorCode | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") {
    return null;
  }

  if (!PUBLIC_ERROR_CODE_SET.has(code)) {
    return null;
  }

  return code as PublicErrorCode;
}
