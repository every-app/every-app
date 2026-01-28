import type { UserAccessApp } from "@/types/app";
import { createSessionToken } from "@/serverFunctions/session-token";
import {
  SessionTokenRequestSchema,
  SessionTokenResponseMessage,
} from "./embedded-app-types";
import { isValidAppOrigin } from "@/utils/origin-validator";

/**
 * Minimal app config needed for token request validation.
 * This is a subset of UserApp to make testing easier.
 */
export interface AppConfig {
  appId: string;
  appUrl: string;
  devUrl?: string | null;
}

/**
 * Result of validating a token request.
 */
type TokenRequestValidationResult =
  | { valid: true; appId: string; requestId: string; appConfig: AppConfig }
  | { valid: false; reason: string };

/**
 * Pure validation function for token requests.
 * Validates that:
 * 1. The message has the correct schema
 * 2. The appId is provided and exists in userApps
 * 3. The request origin matches the app's configured URL
 *
 * This is the security-critical function that prevents cross-app token theft.
 */
export function validateTokenRequest(
  origin: string,
  data: unknown,
  userApps: AppConfig[] | undefined,
): TokenRequestValidationResult {
  // Validate the incoming message schema
  const parseResult = SessionTokenRequestSchema.safeParse(data);
  if (!parseResult.success) {
    return { valid: false, reason: "invalid_schema" };
  }

  const { requestId, appId } = parseResult.data;

  // Validate that appId is provided
  if (!appId) {
    return { valid: false, reason: "missing_app_id" };
  }

  // Find the app config from user apps
  const appConfig = userApps?.find((a) => a.appId === appId);

  if (!appConfig || !appConfig.appUrl) {
    return { valid: false, reason: "unknown_app" };
  }

  // Validate origin matches the app's configured URL (production or dev)
  // This is the critical security check that prevents cross-app attacks
  if (!isValidAppOrigin(origin, appConfig.appUrl, appConfig.devUrl)) {
    return { valid: false, reason: "origin_mismatch" };
  }

  return { valid: true, appId, requestId, appConfig };
}

/**
 * Handles session token requests from embedded apps
 * @param event - The MessageEvent from postMessage
 * @param userApps - Array of user's apps they have access to
 * @returns SessionTokenResponseMessage or null if request is invalid/rejected
 */
export async function handleSessionTokenRequest(
  event: MessageEvent,
  userApps: UserAccessApp[] | undefined,
): Promise<SessionTokenResponseMessage | null> {
  // Ignore react devtools messages
  if (event.data?.source?.startsWith("react-")) {
    return null;
  }

  const validation = validateTokenRequest(event.origin, event.data, userApps);

  if (!validation.valid) {
    if (validation.reason !== "invalid_schema") {
      console.warn(
        `[session-token-handler] Message rejected: ${validation.reason}`,
      );
    }
    return null;
  }

  const { appId, requestId } = validation;

  // Generate and return session token
  try {
    const validatedData = await createSessionToken({
      data: {
        requestOrigin: event.origin,
        appId,
        timestamp: Date.now(),
      },
    });

    return {
      type: "SESSION_TOKEN_RESPONSE",
      requestId,
      token: validatedData.token,
      expiresAt: validatedData.expiresAt,
      audience: validatedData.audience,
      appId: validatedData.appId,
    };
  } catch (error) {
    console.error(
      `[session-token-handler] Error processing token request #${requestId}:`,
      error,
    );
    return {
      type: "SESSION_TOKEN_RESPONSE",
      requestId,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Safely sends a message to a window/iframe
 * @param source - The message source (usually event.source)
 * @param message - The message to send
 * @param origin - The target origin
 */
export function sendMessageToWindow(
  source: MessageEventSource | null,
  message: SessionTokenResponseMessage,
  origin: string,
) {
  if (!source) return;

  // Type guard to check if source is a Window
  if ("postMessage" in source && "parent" in source) {
    source.postMessage(message, origin);
  }
}
