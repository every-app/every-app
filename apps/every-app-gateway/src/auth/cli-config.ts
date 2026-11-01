import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { readAccessConfig } from "./cloudflare-access/config";
import { cloudflareAccess } from "./cloudflare-access/plugin";
import { gatewaySchema, organizationSchema } from "./schema";
import { sharedAuthOptions } from "./shared";
import { signInMethods } from "./sign-in-methods";
import { readSignInProviders } from "./sign-in-providers/config";
import { signInProviders } from "./sign-in-providers/plugin";

/**
 * Necessary because cloudflare bindings don't work in when run as a cli.
 *
 * CLI-only auth configuration for schema generation.
 * Uses sharedAuthOptions to stay in sync with runtime config.
 */
export const auth = betterAuth({
  ...sharedAuthOptions,
  plugins: [
    admin(),
    organization({ schema: organizationSchema }),
    gatewaySchema(),
    // Registered so the plugin list matches a self-hosted gateway's (neither
    // adds to the schema).
    signInMethods({
      access: readAccessConfig({}, { allowLoopback: false }),
      signIn: readSignInProviders({}, { allowLoopback: false }),
      gatewayUrl: undefined,
      policy: { signUp: "invitation", emailVerification: false },
    }),
    signInProviders({
      config: readSignInProviders({}, { allowLoopback: false }),
      openSignUp: false,
    }),
    cloudflareAccess({
      config: readAccessConfig({}, { allowLoopback: false }),
      gatewayUrl: undefined,
    }),
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
