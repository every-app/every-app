import type { PublicErrorCode } from "@/server/errors";

type BetterAuthErrorLike = {
  code?: string;
  message?: string;
} | null;

type ErrorWithCode = {
  code?: unknown;
  data?: {
    code?: unknown;
  };
  cause?: {
    code?: unknown;
  };
};

const SERVER_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
  INTERNAL_ERROR: "Something went wrong. Please try again.",
  INVALID_INPUT: "Invalid request. Please check your input and try again.",
  RATE_LIMITED: "Too many attempts. Please try again later.",
  AUTH_UNAUTHORIZED: "Your session has expired. Please sign in again.",
  OWNER_ALREADY_EXISTS: "An owner already exists. Please sign in.",
  ACCOUNT_CREATION_FAILED: "Failed to create account. Please try again.",
  USER_NOT_FOUND: "User not found.",
  USER_ALREADY_EXISTS: "A user with this email already exists.",
  CANNOT_DELETE_SELF: "You cannot delete your own account.",
  CANNOT_DELETE_OWNER: "Owner accounts cannot be deleted.",
  INVITATION_TOKEN_INVALID:
    "Invalid invitation link. Please request a new invitation.",
  INVITATION_TOKEN_EXPIRED:
    "Invitation link has expired. Please request a new invitation.",
  INVITATION_REQUIRES_PENDING_USER:
    "This user is no longer pending and cannot be re-invited.",
  RESET_TOKEN_INVALID:
    "Invalid reset link. Please request a new password reset.",
  RESET_TOKEN_EXPIRED:
    "Reset link has expired. Please request a new password reset.",
  PASSWORD_RESET_REQUIRES_ACTIVE_USER:
    "Password reset is only available for active users.",
  APP_NOT_FOUND: "App not found.",
  APP_ID_ALREADY_EXISTS: "An app with this ID already exists.",
  TOKEN_NOT_FOUND: "Token not found.",
  INVALID_TOKEN_SCOPE: "One or more scopes are invalid.",
  TOKEN_SCOPE_REQUIRED: "At least one scope is required.",
  TOKEN_SCOPE_LIMIT_EXCEEDED: "Too many scopes were provided.",
  INVALID_EXPIRATION_DATE: "Invalid expiration date.",
  EXPIRATION_IN_PAST: "Expiration date must be in the future.",
};

const BETTER_AUTH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password.",
  USER_ALREADY_EXISTS: "A user with this email already exists.",
  USER_NOT_FOUND: "User not found.",
  TOO_MANY_REQUESTS: "Too many attempts. Please try again later.",
  INVALID_TOKEN: "Invalid link. Please request a new one.",
};

function readCode(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = error as ErrorWithCode;
  return (
    readCode(candidate.code) ??
    readCode(candidate.data?.code) ??
    readCode(candidate.cause?.code) ??
    null
  );
}

export function getServerErrorMessage(
  error: unknown,
  fallback: string,
): string {
  const code = getErrorCode(error);
  if (!code) {
    return fallback;
  }

  if (code in SERVER_ERROR_MESSAGES) {
    return SERVER_ERROR_MESSAGES[code as PublicErrorCode];
  }

  if (code === "UNAUTHORIZED") {
    return SERVER_ERROR_MESSAGES.AUTH_UNAUTHORIZED;
  }

  return fallback;
}

export function getBetterAuthErrorMessage(
  error: BetterAuthErrorLike,
  fallback: string,
): string {
  const code = error?.code;
  if (code && code in BETTER_AUTH_ERROR_MESSAGES) {
    return BETTER_AUTH_ERROR_MESSAGES[code];
  }

  return fallback;
}
