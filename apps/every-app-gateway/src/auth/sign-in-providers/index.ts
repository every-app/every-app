/**
 * Sign-in providers beside passwords ("Continue with Google"): the catalog
 * is packages/sdk/src/internal/signInProviders.ts, the settings are Worker
 * secrets (./config.ts), the providers are Better Auth's (./providers.ts)
 * and who gets in is ./membership.ts. See docs/runbooks/sign-in-providers.md.
 */
import { env } from "cloudflare:workers";
import {
  readSignInProviders,
  reportSignInProviderProblems,
  type SignInProvidersConfig,
} from "./config";

/**
 * The sign-in providers' settings from this Worker's environment. Loopback
 * issuers (a mock provider) are accepted only in `vite dev` builds.
 */
export function signInProvidersFromEnv(): SignInProvidersConfig {
  const config = readSignInProviders(
    env as unknown as Record<string, unknown>,
    {
      allowLoopback: Boolean(import.meta.env.DEV),
    },
  );
  reportSignInProviderProblems(config);
  return config;
}

export { configuredSignInProviderIds } from "./config";
export { signInProviders } from "./plugin";
