/**
 * Cloudflare Access as a way to sign in to Better Auth (OIDC sign-in and the
 * outer ring). See plugin.ts and docs/runbooks/cloudflare-access.md.
 */
import { env } from "cloudflare:workers";
import { platformPolicy } from "@/server/platform-policy";
import {
  readAccessConfig,
  reportAccessConfigProblems,
  type AccessConfig,
} from "./config";

/**
 * The Access sign-in settings from this Worker's environment. Loopback URLs
 * (a mock Access) are accepted only in `vite dev` builds. Where the
 * platform policy has no Access sign-in (hosted, or an invalid mode) there
 * are none, whatever is set: passwords alone, and no outer ring.
 */
export function accessConfigFromEnv(): AccessConfig {
  const options = { allowLoopback: Boolean(import.meta.env.DEV) };
  if (!platformPolicy(env).accessSignIn) {
    const ignored = Object.keys(env).some(
      (name) =>
        (name.startsWith("CLOUDFLARE_ACCESS_") ||
          name === "EMAIL_PASSWORD_SIGN_IN") &&
        Boolean((env as unknown as Record<string, unknown>)[name]),
    );
    const config = {
      ...readAccessConfig({}, options),
      problems: ignored
        ? [
            "The Cloudflare Access settings and EMAIL_PASSWORD_SIGN_IN are ignored: this gateway's GATEWAY_DEPLOYMENT_MODE has no Access sign-in.",
          ]
        : [],
    };
    reportAccessConfigProblems(config);
    return config;
  }
  const config = readAccessConfig(env, options);
  reportAccessConfigProblems(config);
  return config;
}

export { ACCESS_PROVIDER_ID, isAccessSignInConfigured } from "./config";
export { isPasswordSignInOn, joinsWithoutInvitation } from "./membership";
export { cloudflareAccess } from "./plugin";
