import { admin } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { defaultRoles } from "better-auth/plugins/admin/access";

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
      enabled: false,
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
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
    tanstackStartCookies(),
    // Keep Better Auth Expo origin override disabled on Workers and normalize
    // expo-origin in the /api/auth/$ route instead.
    // Context: https://github.com/better-auth/better-auth/issues/5568
    // Context: https://github.com/better-auth/better-auth/issues/7014
    expo({ disableOriginOverride: true }),
    admin({
      defaultRole: "member",
      adminRoles: ["owner"],
      roles: {
        ...defaultRoles,
        owner: defaultRoles.admin,
        member: defaultRoles.user,
      },
    }),
  ],
};
