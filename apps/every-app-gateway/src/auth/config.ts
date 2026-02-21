import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { env } from "cloudflare:workers";
import { sharedAuthOptions } from "./shared";
import {
  getExpoDevTrustedOrigins,
  isExpoDevModeEnabled,
} from "./expo-origin-normalizer";

/**
 * Runtime auth configuration - requires Cloudflare bindings.
 */
export function createAuth() {
  const isDevMode = isExpoDevModeEnabled({
    gatewayUrl: env.GATEWAY_URL,
    viteDev: import.meta.env.DEV,
  });

  // Keep trusted origins intentionally minimal:
  // - gateway URL for normal web traffic
  // - everyapp:// for native app flows
  // - exp://** only during local gateway development
  const trustedOrigins = [
    ...(env.GATEWAY_URL ? [env.GATEWAY_URL] : []),
    "everyapp://",
    ...getExpoDevTrustedOrigins(isDevMode),
  ];

  return betterAuth({
    ...sharedAuthOptions,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    database: drizzleAdapter(drizzle(env.DB, { schema, logger: false }), {
      provider: "sqlite",
      usePlural: true,
    }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
