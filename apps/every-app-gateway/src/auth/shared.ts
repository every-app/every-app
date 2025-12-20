import { admin } from "better-auth/plugins";
import { reactStartCookies } from "better-auth/react-start";

/**
 * User status values:
 * - "pending": User has been invited but hasn't set their password yet
 * - "active": User has completed registration and can sign in
 */
export type UserStatus = "pending" | "active";

/**
 * User role values:
 * - "owner": First user, has full admin access
 * - "member": Regular invited user
 */
export type UserRole = "owner" | "member";

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
    sendResetPassword: async ({
      user,
      url,
    }: {
      user: { email: string };
      url: string;
    }) => {
      // Log the reset URL so owner can find it in logs if they need to reset their own password
      console.log(`[Password Reset] User: ${user.email}, Reset URL: ${url}`);
    },
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
    reactStartCookies(),
    admin({
      defaultRole: "member",
      adminRoles: ["owner"], // Only owners have admin privileges
    }),
  ],
};
