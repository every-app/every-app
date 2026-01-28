import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, type AuthContext } from "@/middleware/auth";
import { AppService } from "@/server/services/AppService";
import { issueEmbeddedAppToken } from "@/server/jwt-utils";
import { EMBEDDED_APP_TOKEN_EXPIRY_SECONDS } from "@/server/constants";
import {
  isValidAppOrigin,
  formatExpectedOrigins,
} from "@/utils/origin-validator";

// Request schemas
const SessionTokenRequestBodySchema = z.object({
  requestOrigin: z
    .string()
    .url()
    .or(z.string().regex(/^http:\/\/localhost:\d+$/)),
  appId: z.string().optional(),
  timestamp: z.number(), // For preventing replay attacks
});

// Timestamp validation constants
// Used to prevent replay attacks where an attacker could intercept and replay
// a token request to gain unauthorized access. By requiring fresh timestamps,
// captured requests become useless after 30 seconds.
const STALE_REQUEST_MAX_AGE_MS = 30000; // 30 seconds
const CLOCK_SKEW_TOLERANCE_MS = 5000; // 5 seconds tolerance for clock skew

/**
 * Validates that a timestamp is fresh enough to prevent replay attacks.
 *
 * @param timestamp - Unix timestamp in milliseconds from the request
 * @param now - Current time (injectable for testing, defaults to Date.now())
 * @returns true if timestamp is within acceptable range
 */
function isTimestampValid(
  timestamp: number,
  now: number = Date.now(),
): boolean {
  const age = now - timestamp;

  // Allow for some clock skew - timestamp can be slightly in the future
  // or up to STALE_REQUEST_MAX_AGE_MS in the past
  return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= STALE_REQUEST_MAX_AGE_MS;
}

// Minimal response - only token and expiry are used by the SDK client
// audience and appId are included for debugging/logging purposes only
type SessionTokenResponse = {
  token: string;
  expiresAt: string;
  audience: string;
  appId: string;
};

export const createSessionToken = createServerFn()
  .middleware([authMiddleware])
  .inputValidator((body: unknown) => SessionTokenRequestBodySchema.parse(body))
  .handler(
    async ({
      data: requestData,
      context,
    }: {
      data: ReturnType<typeof SessionTokenRequestBodySchema.parse>;
      context: AuthContext;
    }) => {
      const { user } = context;
      const { appId, requestOrigin, timestamp } = requestData;

      // Validate timestamp to prevent replay attacks
      if (!isTimestampValid(timestamp)) {
        const now = Date.now();
        const age = timestamp ? now - timestamp : 0;
        console.error(
          `Request timestamp invalid: ${timestamp}, current: ${now}, age: ${age}ms`,
        );
        throw new Error("Request expired or clock skew detected");
      }

      // Look up app configuration and verify user access
      let app = null;

      if (appId) {
        // If appId is provided, verify user has access and origin matches
        app = await AppService.getByAppIdForUser(appId, user.id);

        if (!app) {
          console.error(
            `User ${user.id} does not have access to app: ${appId}`,
          );
          throw new Error("Access denied or invalid app ID");
        }

        // Validate origin directly without making another DB query
        if (!isValidAppOrigin(requestOrigin, app.appUrl, app.devUrl)) {
          const expectedOrigins = formatExpectedOrigins(app.appUrl, app.devUrl);
          console.error(
            `Origin ${requestOrigin} not allowed for app ${appId}. Expected: ${expectedOrigins}`,
          );
          throw new Error("Origin not allowed for this app");
        }
      } else {
        // Otherwise, look up app by origin (also verifies user access)
        app = await AppService.getByOriginForUser(requestOrigin, user.id);

        if (!app) {
          console.error(
            `User ${user.id} does not have access to any app at origin: ${requestOrigin}`,
          );
          throw new Error("Access denied or unregistered origin");
        }
      }

      // Issue a JWT token for the specific embedded app
      // The token contains minimal claims: sub (userId), email, aud (appId), iss, exp, iat
      const token = await issueEmbeddedAppToken(user, app.appId, {});

      const response: SessionTokenResponse = {
        token,
        expiresAt: new Date(
          Date.now() + EMBEDDED_APP_TOKEN_EXPIRY_SECONDS * 1000,
        ).toISOString(),
        audience: app.appId,
        appId: app.appId,
      };

      return response;
    },
  );
