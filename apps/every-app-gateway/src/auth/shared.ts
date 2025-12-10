import { reactStartCookies } from "better-auth/react-start";

/**
 * Shared auth configuration options.
 * Used by both runtime and CLI configs to keep them in sync.
 */
export const sharedAuthOptions = {
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // Cache duration in seconds
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async (
      {
        user,
        url,
        token,
      }: { user: { email: string }; url: string; token: string },
      _: unknown,
    ) => {
      // Password reset links are logged to console for admin access via Cloudflare logs
      console.log(`Password reset requested for ${user.email}`);
      console.log(`Reset URL: ${url}`);
      console.log(`Token: ${token}`);
    },
  },
  plugins: [reactStartCookies()],
};
