/**
 * `GET /api/auth/sign-in-methods`: what the sign-in pages offer, in every
 * mode. Passwords (unless turned off), "Continue with <label>" for
 * Cloudflare Access and for each sign-in provider that is on (Google,
 * Microsoft, GitHub, Apple, SSO), and who Access says this browser belongs
 * to. The Access settings are empty where the platform policy has no
 * Access sign-in; sign-up comes from the policy.
 */
import { HIDE_METADATA, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { PublicPolicy } from "@/server/platform-policy";
import {
  ACCESS_PROVIDER_ID,
  type AccessConfig,
} from "./cloudflare-access/config";
import { outerRingSignInIdentity } from "./cloudflare-access/plugin";
import {
  configuredSignInProviderIds,
  type SignInProvidersConfig,
} from "./sign-in-providers/config";

export interface SignInMethods extends PublicPolicy {
  emailPassword: boolean;
  /**
   * "Continue with <label>", one per provider that is on: Cloudflare Access
   * (`cloudflare-access`) first, then the sign-in providers in catalog order
   * (`google`, `microsoft`, `github`, `apple`, `oidc`).
   */
  providers: { id: string; label: string }[];
  /**
   * The person Cloudflare Access says this browser belongs to, when the
   * request came through the outer ring.
   */
  accessEmail: string | null;
  /**
   * Whether the gateway sends email. Without a sender, invitations and
   * password resets are links an admin hands out, and the reset pages say so
   * instead of promising a message.
   */
  emailConfigured: boolean;
}

export function signInMethods(options: {
  access: AccessConfig;
  signIn: SignInProvidersConfig;
  gatewayUrl: string | undefined;
  policy: PublicPolicy;
}) {
  const { access, signIn, gatewayUrl, policy } = options;
  const signInIds = configuredSignInProviderIds(signIn);
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
          // Loaded on first use: they read the gateway's database and Worker
          // env, which the CLI's schema config (cli-config.ts) can't load.
          const [{ isPasswordSignInOn }, { isEmailConfigured }] =
            await Promise.all([
              import("./cloudflare-access/membership"),
              import("@/server/email/sendEmail"),
            ]);
          ctx.setHeader("cache-control", "no-store");
          const methods: SignInMethods = {
            emailPassword: await isPasswordSignInOn(access, signInIds),
            providers: [
              ...(access.oidc
                ? [{ id: ACCESS_PROVIDER_ID, label: access.oidc.label }]
                : []),
              ...signIn.providers.map((provider) => ({
                id: provider.id,
                label: provider.label,
              })),
            ],
            accessEmail: identity?.email ?? null,
            emailConfigured: isEmailConfigured(),
            ...policy,
          };
          return ctx.json(methods);
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
