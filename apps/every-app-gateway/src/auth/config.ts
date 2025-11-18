import { betterAuth } from "better-auth";
import { reactStartCookies } from "better-auth/react-start";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { getBindings } from "../server/bindings";

// Single auth configuration that handles both CLI and runtime scenarios
export function createAuth() {
  let env = undefined;

  try {
    env = getBindings();
  } catch {
    console.log("Cloudflare bindings not necessary during better auth cli");
  }

  return betterAuth({
    secret: env?.BETTER_AUTH_SECRET,
    trustedOrigins: env ? [env.GATEWAY_URL] : [],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // Cache duration in seconds
      },
    },
    // Email verification is not required for this gateway
    // Users can access password reset links via Cloudflare logs
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      sendResetPassword: async ({ user, url, token }, _) => {
        // Password reset links are logged to console for admin access via Cloudflare logs
        console.log(`Password reset requested for ${user.email}`);
        console.log(`Reset URL: ${url}`);
        console.log(`Token: ${token}`);
      },
    },
    plugins: [
      reactStartCookies(), // Add this plugin last as recommended
    ],
    database: drizzleAdapter(
      // The env will not exist in CLI mode.
      // This doens't need an actual db to generate the schema though so pass in an empty {}
      env ? drizzle(env.DB, { schema, logger: false }) : {},
      { provider: "sqlite", usePlural: true },
    ),
  });
}
