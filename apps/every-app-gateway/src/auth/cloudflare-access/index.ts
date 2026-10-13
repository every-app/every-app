/**
 * Cloudflare Access as a way to sign in to Better Auth (OIDC sign-in and the
 * outer ring). See plugin.ts and docs/runbooks/cloudflare-access.md.
 */
import { env } from "cloudflare:workers";
import {
  readAccessConfig,
  reportAccessConfigProblems,
  type AccessConfig,
} from "./config";

/**
 * The Access sign-in settings from this Worker's environment. Loopback URLs
 * (a mock Access) are accepted only in `vite dev` builds.
 */
export function accessConfigFromEnv(): AccessConfig {
  const config = readAccessConfig(env, {
    allowLoopback: Boolean(import.meta.env.DEV),
  });
  reportAccessConfigProblems(config);
  return config;
}

export { ACCESS_PROVIDER_ID, isAccessSignInConfigured } from "./config";
export { isPasswordSignInOn, joinsWithoutInvitation } from "./membership";
export { cloudflareAccess, type SignInMethods } from "./plugin";
