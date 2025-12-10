import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sharedAuthOptions } from "./shared";

/**
 * Necessary because cloudflare bindings don't work in when run as a cli.
 *
 * CLI-only auth configuration for schema generation.
 * Uses sharedAuthOptions to stay in sync with runtime config.
 */
export const auth = betterAuth({
  ...sharedAuthOptions,
  database: drizzleAdapter({} as any, {
    provider: "sqlite",
    usePlural: true,
  }),
});
