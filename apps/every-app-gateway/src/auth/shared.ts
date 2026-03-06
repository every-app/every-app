import { expo } from "@better-auth/expo";
import { tanstackStartCookies } from "better-auth/tanstack-start";

/**
 * Shared auth configuration options.
 * Used by both runtime and CLI configs to keep them in sync.
 */
export const sharedAuthOptions = {
  session: {
    cookieCache: {
      enabled: false,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: false,
  },
  user: {
    additionalFields: {
      status: {
        type: "string" as const,
        required: false,
        defaultValue: "active",
        input: false, // Don't allow setting via normal sign-up
      },
    },
  },
  plugins: [
    tanstackStartCookies(),
    // Keep Better Auth Expo origin override disabled on Workers and normalize
    // expo-origin in the /api/auth/$ route instead.
    // Context: https://github.com/better-auth/better-auth/issues/5568
    // Context: https://github.com/better-auth/better-auth/issues/7014
    expo({ disableOriginOverride: true }),
  ],
};
