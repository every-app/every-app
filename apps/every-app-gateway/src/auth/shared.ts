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
};
