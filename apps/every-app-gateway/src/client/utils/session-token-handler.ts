import { UserApp } from "@/types/user-app";
import { createSessionToken } from "@/serverFunctions/session-token";
import {
  SessionTokenRequestSchema,
  SessionTokenResponseMessage,
} from "./embedded-app-types";

/**
 * Handles session token requests from embedded apps
 * @param event - The MessageEvent from postMessage
 * @param userApps - Array of user's installed apps
 * @returns SessionTokenResponseMessage or null if request is invalid/rejected
 */
export async function handleSessionTokenRequest(
  event: MessageEvent,
  userApps: UserApp[] | undefined,
): Promise<SessionTokenResponseMessage | null> {
  // Validate the incoming message first to get appId
  const parseResult = SessionTokenRequestSchema.safeParse(event.data);
  if (!parseResult.success) {
    // Ignore react devtools messages
    if (event.data?.source?.startsWith("react-")) {
      return null;
    }
    return null;
  }

  const { requestId, appId } = parseResult.data;

  // Validate that appId is provided
  if (!appId) {
    console.warn(
      `[session-token-handler] Message rejected - missing appId in request`,
    );
    return null;
  }

  // Find the app config from either user apps or marketplace apps
  const appConfig = userApps?.find((a) => a.appId === appId);

  if (!appConfig || !appConfig.appUrl) {
    console.warn(
      `[session-token-handler] Message rejected - unknown or misconfigured app: ${appId}`,
    );
    return null;
  }

  // Validate origin matches the app's configured URL
  if (event.origin !== new URL(appConfig.appUrl).origin) {
    console.warn(
      `[session-token-handler] Message rejected from unexpected origin: ${event.origin} (expected: ${new URL(appConfig.appUrl).origin} for app: ${appId})`,
    );
    return null;
  }

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
