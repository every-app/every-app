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
  INVITATION_EMAIL_MISMATCH:
    "This invitation is for a different email address. Sign in with the invited email to accept it.",
  INVITATION_REQUIRES_PENDING_USER:
    "This user is no longer pending and cannot be re-invited.",
  INVITATION_NOT_FOUND:
    "That invitation doesn't exist or is no longer pending.",
  ALREADY_INVITED: "This email address already has a pending invitation.",
  ALREADY_MEMBER: "This email address already belongs to a member.",
  INVITATION_LIMIT_REACHED:
    "This organization has too many pending invitations. Cancel some before inviting more.",
  INVALID_ORGANIZATION_NAME: "Use 1 to 64 characters with no line breaks.",
  EMAIL_NOT_CONFIGURED:
    "This gateway can't send email. Copy a password-reset link instead.",
  EMAIL_DELIVERY_FAILED:
    "The email could not be sent. Copy a password-reset link instead.",
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
  OAUTH_DISABLED: "OAuth connections are not enabled on this gateway.",
  CONNECTION_NOT_FOUND: "That connection doesn't exist or was already revoked.",
  CANNOT_MANAGE_SELF:
    "You cannot change your own role or deactivate your own account.",
  CANNOT_MANAGE_OWNER:
    "An owner's password can't be reset from here: a reset link would hand their account to whoever holds it.",
  OWNER_REQUIRED: "Only an owner can change an admin or an owner.",
  LAST_OWNER:
    "The last owner can't be changed or removed; make someone else an owner first.",
  USER_IN_OTHER_ORGANIZATION:
    "This user also belongs to another organization, so their account can't be deactivated or reset from here.",
  PASSWORD_SIGN_IN_DISABLED:
    "Password sign-in is turned off on this gateway, so a password reset wouldn't work. People sign in with Cloudflare Access.",
  ACCOUNT_ACTIONS_UNAVAILABLE:
    "Accounts belong to the people who own them on this gateway, so they can't be deactivated or reset from an organization. Remove the member instead.",
  EMAIL_NOT_VERIFIED: "Verify your email address before inviting anyone.",
  SHARED_APP_ACCESS:
    "Every member of every organization can open a shared app, so its access can't be changed.",
  DEPLOY_KEYS_UNAVAILABLE:
    "This gateway doesn't take third-party deploys, so it makes no deploy keys.",
  GROUP_NOT_FOUND: "That group doesn't exist or was deleted.",
  GROUP_NAME_TAKEN: "A group with this name already exists.",
  EVENT_TARGET_REFUSED:
    "That URL can't be a webhook target: use https and a public hostname, not this gateway or one of its apps.",
  EVENT_SUBSCRIPTIONS_LIMIT:
    "This workspace has as many event subscriptions as it may. Remove one first.",
  EVENT_SUBSCRIPTION_NOT_FOUND:
    "That subscription doesn't exist or was removed.",
  EVENT_DELIVERY_NOT_FOUND: "That delivery doesn't exist any more.",
  EVENT_TYPE_UNKNOWN:
    "One of the event types isn't one the gateway emits. Pick from the list, or use a pattern like member.* or app.crm.*.",
  EVENT_SECRET_INVALID:
    "A signing secret is 16 to 128 characters with no spaces.",
  EVENT_SINK_CONFLICT:
    "A subscription is a webhook URL or an email to owners and admins, not both.",
  // The rules' own messages say more (getRuleErrorMessage); these are the
  // fallbacks for an error that arrives without one.
  REMOTE_MCP_INVALID: "Check the server's details and try again.",
  REMOTE_MCP_URL_REFUSED: "The Gateway can't use that URL.",
  REMOTE_MCP_EXISTS: "An MCP app with this name is on this Gateway already.",
  REMOTE_MCP_SECRET_TAKEN:
    "That credential name belongs to another MCP app; choose another.",
  APP_TIER_MISMATCH: "That name belongs to another app on this Gateway.",
  PROVIDER_NOT_FOUND: "No such provider on this Gateway.",
  PROVIDER_SPEC_INVALID: "The provider spec is not valid.",
  PROVIDER_EXISTS: "That provider is registered already.",
  PROVIDER_BUILTIN: "That provider is built in.",
  PROVIDER_SECRET_TAKEN: "A setting that provider names is already taken.",
  PROVIDER_HOST_REFUSED:
    "A host that provider names can't be reached from this Gateway.",
  PROVIDER_IN_USE: "An app still lists that provider.",
  PROVIDER_BOUND: "That provider's settings are set from the terminal.",
  OAUTH_PROVIDER_REQUIRED: "That provider is not an OAuth provider.",
  OAUTH_CLIENT_REQUIRED: "Paste the client id and the client secret.",
  SEALING_UNAVAILABLE: "This Gateway can't store a secret yet.",
  ADMIN_REQUIRED: "Only an owner or admin can do that.",
  PROVIDER_HOSTED:
    "On a hosted gateway the platform's operator manages providers and their clients.",
  SCOPE_SET_INVALID: "That scope set isn't one this client takes.",
  SCOPE_SET_PROVIDER_UNKNOWN:
    "Scope sets are added to a built-in OAuth client with scope sets.",
  SCOPE_SET_BUILTIN: "That scope set is the client's own.",
  SCOPE_SET_EXISTS: "That scope set is added already.",
  SCOPE_SET_NOT_FOUND: "No scope set of that name was added here.",
  SCOPE_SET_IN_USE: "An app still lists that scope set.",
  GATEWAY_OUTDATED: "This Gateway needs an update first.",
};

/**
 * Codes whose message is a registry rule's own sentence, written to be
 * read by the person who hit it (the URL rule, the credential's name):
 * shown as the server sent it rather than as a canned line.
 */
const RULE_MESSAGE_CODES: ReadonlySet<string> = new Set<PublicErrorCode>([
  // The event target rules and the pattern and secret checks
  // (server/events/target.ts, subscriptions.ts) name what is wrong.
  "EVENT_TARGET_REFUSED",
  "EVENT_TYPE_UNKNOWN",
  "EVENT_SECRET_INVALID",
  "REMOTE_MCP_INVALID",
  "REMOTE_MCP_URL_REFUSED",
  "REMOTE_MCP_EXISTS",
  "REMOTE_MCP_SECRET_TAKEN",
  "APP_TIER_MISMATCH",
  // The OAuth provider rules (server/oauth/service.ts) name what is wrong.
  "PROVIDER_NOT_FOUND",
  "PROVIDER_SPEC_INVALID",
  "PROVIDER_EXISTS",
  "PROVIDER_BUILTIN",
  "PROVIDER_SECRET_TAKEN",
  "PROVIDER_HOST_REFUSED",
  "PROVIDER_IN_USE",
  "PROVIDER_BOUND",
  "OAUTH_PROVIDER_REQUIRED",
  "OAUTH_CLIENT_REQUIRED",
  "SEALING_UNAVAILABLE",
  "PROVIDER_HOSTED",
  "SCOPE_SET_INVALID",
  "SCOPE_SET_PROVIDER_UNKNOWN",
  "SCOPE_SET_BUILTIN",
  "SCOPE_SET_EXISTS",
  "SCOPE_SET_NOT_FOUND",
  "SCOPE_SET_IN_USE",
  "GATEWAY_OUTDATED",
]);

/** A rule's fragment as a sentence: a capital first, a full stop last. */
export function asSentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0]!.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/**
 * The message to show for a server-function error: a registry rule's own
 * sentence for its codes ({@link RULE_MESSAGE_CODES}), else the canned
 * line for the code ({@link getServerErrorMessage}).
 */
export function getRuleErrorMessage(error: unknown, fallback: string): string {
  const code = getErrorCode(error);
  const message = (error as { message?: unknown } | null)?.message;
  if (
    code &&
    RULE_MESSAGE_CODES.has(code) &&
    typeof message === "string" &&
    message.trim() &&
    message !== code
  ) {
    return asSentence(message);
  }
  return getServerErrorMessage(error, fallback);
}

const BETTER_AUTH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password.",
  USER_ALREADY_EXISTS: "A user with this email already exists.",
  USER_NOT_FOUND: "User not found.",
  TOO_MANY_REQUESTS: "Too many attempts. Please try again later.",
  INVALID_TOKEN: "Invalid link. Please request a new one.",
  TOKEN_EXPIRED: "This link has expired. Please request a new one.",
  EMAIL_NOT_VERIFIED: "Verify your email address to sign in.",
  EMAIL_NOT_CONFIGURED:
    "Sign-up is unavailable right now: this gateway can't send email yet.",
  ACCOUNT_CREATION_FAILED:
    "Your account couldn't be created. Please try again.",
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
