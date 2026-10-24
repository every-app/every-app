/**
 * `GET /api/auth/sign-in-methods`: what the sign-in pages offer, in every
 * mode. Passwords (unless turned off),
 * "Continue with <label>" for Cloudflare Access and who Access says this
 * browser belongs to come from the Access settings, which are empty where
 * the platform policy has no Access sign-in; sign-up comes from the policy.
 */
import { HIDE_METADATA, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { PublicPolicy } from "@/server/platform-policy";
import {
  ACCESS_PROVIDER_ID,
  type AccessConfig,
} from "./cloudflare-access/config";
import { outerRingSignInIdentity } from "./cloudflare-access/plugin";

export interface SignInMethods extends PublicPolicy {
  emailPassword: boolean;
  providers: { id: string; label: string }[];
  /**
   * The person Cloudflare Access says this browser belongs to, when the
   * request came through the outer ring.
   */
  accessEmail: string | null;
}

export function signInMethods(options: {
  access: AccessConfig;
  gatewayUrl: string | undefined;
  policy: PublicPolicy;
}) {
  const { access, gatewayUrl, policy } = options;
  return {
    id: "sign-in-methods",
    endpoints: {
      signInMethods: createAuthEndpoint(
        "/sign-in-methods",
        { method: "GET", metadata: HIDE_METADATA },
        async (ctx) => {
          const identity = await outerRingSignInIdentity(
            access,
            gatewayUrl,
            ctx.request,
          );
          // Loaded on first use: it reads the gateway's database, which the
          // CLI's schema config (cli-config.ts) can't load.
          const { isPasswordSignInOn } = await import(
            "./cloudflare-access/membership"
          );
          ctx.setHeader("cache-control", "no-store");
          const methods: SignInMethods = {
            emailPassword: await isPasswordSignInOn(access),
            providers: access.oidc
              ? [{ id: ACCESS_PROVIDER_ID, label: access.oidc.label }]
              : [],
            accessEmail: identity?.email ?? null,
            ...policy,
          };
          return ctx.json(methods);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
