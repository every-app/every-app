import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "../db";
import { env } from "cloudflare:workers";
import { sharedAuthOptions } from "./shared";

/**
 * Runtime auth configuration - requires Cloudflare bindings.
 */
export function createAuth() {
  return betterAuth({
    ...sharedAuthOptions,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.GATEWAY_URL ? [env.GATEWAY_URL] : [],
    database: drizzleAdapter(drizzle(env.DB, { schema, logger: false }), {
      provider: "sqlite",
      usePlural: true,
    }),
  });
}

export type Auth = ReturnType<typeof createAuth>;
