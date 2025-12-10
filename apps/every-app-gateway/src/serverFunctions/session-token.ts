import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware, type AuthContext } from "@/middleware/auth";
import { AppResolver } from "@/serverFunctions/apps";
import { issueEmbeddedAppToken } from "@/server/jwt-utils";

// Request schemas
const SessionTokenRequestBodySchema = z.object({
  requestOrigin: z
    .string()
    .url()
    .or(z.string().regex(/^http:\/\/localhost:\d+$/)),
  appId: z.string().optional(),
  timestamp: z.number(), // For preventing replay attacks
});

// Response schemas
const SessionTokenResponseSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
  audience: z.string(),
  appId: z.string(),
  user: z.object({
    id: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
  }),
});

type SessionTokenResponse = z.infer<typeof SessionTokenResponseSchema>;

// Timestamp validation constants
// Used to prevent replay attacks where an attacker could intercept and replay
// a token request to gain unauthorized access. By requiring fresh timestamps,
// captured requests become useless after 30 seconds.
const STALE_REQUEST_MAX_AGE_MS = 30000; // 30 seconds
const CLOCK_SKEW_TOLERANCE_MS = 5000; // 5 seconds tolerance for clock skew

// Helper to validate timestamp for preventing replay attacks
function isTimestampValid(timestamp: number): boolean {
  const now = Date.now();
  const age = now - timestamp;

  // Allow for some clock skew - timestamp can be slightly in the future
  // or up to STALE_REQUEST_MAX_AGE_MS in the past
  return age >= -CLOCK_SKEW_TOLERANCE_MS && age <= STALE_REQUEST_MAX_AGE_MS;
}

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

      // SECURITY: Require postMessage flow - direct HTTP requests are not allowed
      if (!requestOrigin) {
        throw new Error(
          "Direct requests not allowed. Tokens must be requested through the postMessage flow.",
        );
      }

      // Look up app configuration
      let app = null;

      if (appId) {
        // If appId is provided, verify it matches the origin
        app = await AppResolver.getApp(appId, user.id);

        if (!app) {
          console.error(`Invalid app ID: ${appId}`);
          throw new Error("Invalid app ID");
        }

        // Validate origin directly without making another DB query
        const appOrigin = new URL(app.appUrl).origin;
        if (appOrigin !== requestOrigin) {
          console.error(
            `Origin ${requestOrigin} not allowed for app ${appId}. Expected: ${appOrigin}`,
          );
          throw new Error("Origin not allowed for this app");
        }
      } else {
        // Otherwise, look up app by origin
        app = await AppResolver.getAppByOrigin(requestOrigin, user.id);

        if (!app) {
          console.error(`Unregistered origin: ${requestOrigin}`);
          throw new Error("Unregistered origin");
        }
      }

      // Issue a JWT token for the specific embedded app
      const token = await issueEmbeddedAppToken(
        {
          ...user,
          name: user.name || "", // Provide default empty string if name is undefined
        },
        app.appId,
        {
          appId: app.appId,
          permissions: [],
          embeddedApp: true,
        },
      );

      const response: SessionTokenResponse = {
        token,
        expiresAt: new Date(Date.now() + 60 * 1000).toISOString(), // 1 minute from now
        audience: app.appId, // Use appId as audience
        appId: app.appId,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      };

      return response;
    },
  );
