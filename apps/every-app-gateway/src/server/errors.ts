const GATEWAY_ERROR_CODES = [
  "UNAUTHORIZED",
  "ORIGIN_NOT_ALLOWED",
  "REQUEST_EXPIRED",
  "ACCESS_DENIED",
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
  "INVITATION_REQUIRES_PENDING_USER",
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
