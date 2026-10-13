import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { sharedAuthOptions } from "./shared";

/**
 * Necessary because cloudflare bindings don't work in when run as a cli.
 *
 * CLI-only auth configuration for schema generation.
 * Uses sharedAuthOptions to stay in sync with runtime config.
 */
export const auth = betterAuth({
  ...sharedAuthOptions,
  plugins: [
    ...sharedAuthOptions.plugins,
    admin(),
    organization(),
    tanstackStartCookies(),
  ],
  // A Drizzle instance that carries the schema (no live D1 behind it), so
  // `auth check schema` validates src/db/auth.schema.ts the same way the
  // runtime adapter does at init.
  database: drizzleAdapter(drizzle({} as D1Database, { schema }), {
    provider: "sqlite",
    usePlural: true,
  }),
});
