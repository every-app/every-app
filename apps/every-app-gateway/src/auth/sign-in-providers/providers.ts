/**
 * The Better Auth providers for the sign-in providers that are on: Better
 * Auth's own Google, GitHub, Microsoft and Apple providers (each knows its
 * endpoints, how to verify its ID token and where the email comes from),
 * and the gateway's generic OIDC one (./oidc-provider.ts).
 *
 * Every one of them is set up the same way: identity scopes only, the
 * stable subject as the account key, no sign-in by posting an ID token
 * (one flow: the redirect, with Better Auth's state and PKCE), and the
 * email's verified flag read the way each provider reports it. Who may sign
 * in is ./membership.ts; nothing here decides that.
 */
import type { OAuthProvider } from "better-auth/oauth2";
import {
  apple,
  cloudflare,
  github,
  google,
  microsoft,
} from "better-auth/social-providers";
import type { SignInProviderConfig } from "./config";
import { createOidcSignInProvider } from "./oidc-provider";

/**
 * Microsoft's fixed tenant for personal accounts: their addresses are the
 * person's own, verified by Microsoft.
 */
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MICROSOFT_MULTI_TENANT = new Set([
  "common",
  "organizations",
  "consumers",
]);

/**
 * Whether a Microsoft ID token's email counts as verified. In a tenant the
 * operator pinned (MICROSOFT_SIGNIN_TENANT), their own directory asserts
 * it. On the multi-tenant endpoints any tenant's admin can put any address
 * on their users (the "nOAuth" problem), so the token must say the address
 * was verified: `xms_edov` (the optional claim "email domain owner
 * verified"), `email_verified`, a matching `verified_primary_email`, or a
 * personal Microsoft account (its `tid` is the consumer tenant).
 */
export function microsoftEmailVerified(
  claims: Record<string, unknown>,
  tenant: string,
): boolean {
  const email = typeof claims.email === "string" ? claims.email : "";
  if (!email) return false;
  if (!MICROSOFT_MULTI_TENANT.has(tenant)) return claims.tid === tenant;
  if (claims.xms_edov === true || claims.email_verified === true) return true;
  if (claims.tid === MICROSOFT_CONSUMER_TENANT_ID) return true;
  const verified = claims.verified_primary_email;
  return Array.isArray(verified) && verified.includes(email);
}

/** One flow only: the redirect through the provider, never a posted ID token. */
const REDIRECT_ONLY = { disableIdTokenSignIn: true } as const;

function createSignInProvider(
  config: SignInProviderConfig,
): OAuthProvider<object> {
  const { clientId, clientSecret } = config;
  switch (config.id) {
    case "google":
      return google({
        clientId,
        clientSecret,
        // Someone with several Google accounts picks one every time.
        prompt: "select_account",
        ...REDIRECT_ONLY,
      }) as OAuthProvider<object>;
    case "github":
      return github({
        clientId,
        clientSecret,
        ...REDIRECT_ONLY,
      }) as OAuthProvider<object>;
    case "microsoft": {
      const tenant = config.tenant ?? "common";
      return microsoft({
        clientId,
        clientSecret,
        tenantId: tenant,
        // Identity only: no Graph scopes, no refresh token.
        disableDefaultScope: true,
        scope: ["openid", "profile", "email"],
        disableProfilePhoto: true,
        mapProfileToUser: (profile) => ({
          emailVerified: microsoftEmailVerified(
            profile as Record<string, unknown>,
            tenant,
          ),
        }),
        ...REDIRECT_ONLY,
      }) as OAuthProvider<object>;
    }
    case "apple":
      return apple({
        clientId,
        clientSecret,
        ...REDIRECT_ONLY,
      }) as OAuthProvider<object>;
    case "cloudflare":
      return cloudflare({
        clientId,
        clientSecret,
        // Cloudflare's /user reports no verified flag. The address is the
        // account's sign-in address, and a private client (the default,
        // and the setup guide's instruction) is only authorized by members
        // of the operator's own Cloudflare account, who joined it by
        // accepting an invitation sent to that address: the same trust the
        // Access "Sign in with Cloudflare" identity provider rests on with
        // "Restrict to account members" on.
        mapProfileToUser: () => ({ emailVerified: true }),
        ...REDIRECT_ONLY,
      }) as OAuthProvider<object>;
    case "oidc":
      return createOidcSignInProvider({
        ...config,
        issuer: config.issuer!,
      }) as OAuthProvider<object>;
  }
}

export function createSignInProviders(
  configs: readonly SignInProviderConfig[],
): OAuthProvider<object>[] {
  return configs.map(createSignInProvider);
}
