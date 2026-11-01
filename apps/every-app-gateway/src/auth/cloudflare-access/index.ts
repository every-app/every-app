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
  type AccessOuterRingConfig,
} from "./config";
import { readAccessAssertion } from "./jwt";
import { verifyOuterRingAssertion } from "./outer-ring";
import { readSignInProviders } from "../sign-in-providers/config";

/**
 * The Access sign-in settings from this Worker's environment. Loopback URLs
 * (a mock Access) are accepted only in `vite dev` builds. Where the
 * platform policy has no Access sign-in (hosted, or an invalid mode) there
 * are none, whatever is set: passwords alone, and no outer ring.
 */
export function accessConfigFromEnv(): AccessConfig {
  const allowLoopback = Boolean(import.meta.env.DEV);
  const options = {
    allowLoopback,
    // A sign-in provider that is on lets EMAIL_PASSWORD_SIGN_IN=false take
    // effect even without Access (the config's own problem message).
    otherSignInConfigured:
      readSignInProviders(env as unknown as Record<string, unknown>, {
        allowLoopback,
      }).providers.length > 0,
  };
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

// The outer-ring configuration the perimeter's prewarm uses, read once per
// isolate (reading it reports its problems, which should be said once).
let outerRingForPrewarm: AccessOuterRingConfig | null | undefined;

export function resetOuterRingPrewarmForTests(): void {
  outerRingForPrewarm = undefined;
}

/**
 * Start verifying the request's Access assertion, if the outer ring is on
 * and the request carries one, without waiting for it: the result is kept
 * in outer-ring.ts, where the session check (plugin.ts) finds it a moment
 * later instead of fetching the team's keys and checking the signature
 * after the session's own reads. Nothing here decides anything: the
 * session check still verifies, and still refuses, exactly as before.
 */
export function prewarmOuterRingAssertion(headers: Headers): void {
  if (outerRingForPrewarm === undefined) {
    const config = accessConfigFromEnv();
    let gatewayHost: string | null = null;
    try {
      gatewayHost = env.GATEWAY_URL ? new URL(env.GATEWAY_URL).host : null;
    } catch {
      gatewayHost = null;
    }
    outerRingForPrewarm =
      config.outerRing && gatewayHost ? config.outerRing : null;
  }
  if (!outerRingForPrewarm || !readAccessAssertion(headers)) return;
  void verifyOuterRingAssertion(headers, outerRingForPrewarm).catch(
    () => undefined,
  );
}

export { ACCESS_PROVIDER_ID, isAccessSignInConfigured } from "./config";
export { isPasswordSignInOn, joinsWithoutInvitation } from "./membership";
export { cloudflareAccess } from "./plugin";
