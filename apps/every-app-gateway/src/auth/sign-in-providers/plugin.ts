/**
 * The Better Auth plugin that makes the configured sign-in providers
 * (Google, Microsoft, GitHub, Apple, a generic OIDC issuer) ways to get a
 * normal Better Auth session. Better Auth stays the system of record and
 * drives the whole flow with its own endpoints (`/sign-in/social`,
 * `/callback/<id>`, `/link-social`), state and PKCE; this registers the
 * providers (./providers.ts) and applies the gateway's membership policy
 * (./membership.ts) through database hooks, so it holds whichever provider
 * creates the user or the session.
 *
 * Linking an identity to an existing account with the same email follows
 * Better Auth 1.7's rules for providers that aren't in `trustedProviders`
 * (none of these are): the provider must report the email verified, and the
 * existing account's own email must be verified too, or the link is made
 * while signed in to the account (`/link-social`, the account menu's
 * "Connect <provider>"), so an account someone registered with another
 * person's address is never handed to that person.
 *
 * Behind Cloudflare Access's outer ring the Access plugin's own hooks still
 * run (a session is only made for the person Access vouches for on the
 * request): the ring stays in front, unchanged.
 */
import type { BetterAuthPlugin } from "better-auth";
import type { SignInProvidersConfig } from "./config";
import { configuredSignInProviderIds } from "./config";
import { createSignInProviders } from "./providers";

interface SignInProvidersPluginOptions {
  config: SignInProvidersConfig;
  /** Anyone with a verified email may make an account (the hosted gateway). */
  openSignUp: boolean;
}

export function signInProviders(options: SignInProvidersPluginOptions) {
  const { config, openSignUp } = options;
  const configured = configuredSignInProviderIds(config);
  const providers = createSignInProviders(config.providers);

  return {
    id: "sign-in-providers",
    // Its unique index on accounts, one row per provider identity, is the
    // gateway's schema plugin's (auth/schema.ts).
    init(ctx) {
      return {
        ...(providers.length > 0
          ? {
              context: {
                socialProviders: [...providers, ...ctx.socialProviders],
              },
            }
          : {}),
        options: {
          databaseHooks: {
            user: {
              create: {
                async before(user, hookCtx) {
                  // Loaded on first use: the membership policy reads the
                  // gateway's database, which the CLI's schema config
                  // (cli-config.ts, run by `auth generate` outside
                  // Workers) can't load.
                  const { signInProviderOf, assertSignInUserMayBeCreated } =
                    await import("./membership");
                  const provider = signInProviderOf(hookCtx, configured);
                  if (!provider) return;
                  await assertSignInUserMayBeCreated(user, provider, {
                    openSignUp,
                  });
                },
              },
            },
            session: {
              create: {
                async before(session, hookCtx) {
                  const { signInProviderOf, ensureSignInMembership } =
                    await import("./membership");
                  const provider = signInProviderOf(hookCtx, configured);
                  if (!provider) return;
                  await ensureSignInMembership(session.userId, provider);
                },
              },
            },
          },
        },
      };
    },
  } satisfies BetterAuthPlugin;
}
