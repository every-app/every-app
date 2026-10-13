/**
 * Cloudflare Access for SaaS as a Better Auth sign-in provider: the
 * "Continue with <label>" button. Access runs the login (its identity
 * providers, MFA and policies) and hands back an ID token; Better Auth turns
 * that into one of its own sessions, so everything after sign-in is the same
 * as for a password.
 *
 * Better Auth drives the flow (`/sign-in/social`, `/callback/cloudflare-access`)
 * with its own state and PKCE (S256); this supplies the endpoints and reads
 * the identity:
 *
 *  - The endpoints derive from the issuer, so nothing is fetched when the
 *    gateway starts (a slow Access can't delay every sign-in) and the ID
 *    token's keys are fetched only when someone signs in.
 *  - The ID token from the token endpoint is verified in full (RS256 by the
 *    application's JWKS, issuer, audience = client id, expiry) before its
 *    email is used.
 *  - The account is keyed by the verified email, not `sub`: Access changes
 *    `sub` when someone is removed and added back.
 *  - No nonce: the code is bound to this browser by Better Auth's state and
 *    PKCE and redeemed with the client secret, and the ID token comes
 *    straight from the token endpoint, as in Cloudflare's own Access for SaaS
 *    examples.
 *  - Signing in by posting an ID token (Better Auth's `idToken` option) isn't
 *    offered: there is no `idToken` verification config on the provider.
 */
import {
  createAuthorizationURL,
  validateAuthorizationCode,
  type OAuthProvider,
} from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { ACCESS_PROVIDER_ID, type AccessOidcConfig } from "./config";
import { jwksClientFor, verifyAccessJwt } from "./jwt";

/** The ID token claims an Access for SaaS application returns. */
type AccessIdTokenClaims = JWTPayload & { email: string };

const SCOPES = ["openid", "email", "profile"];

export function createAccessOidcProvider(
  config: AccessOidcConfig,
): OAuthProvider<AccessIdTokenClaims> {
  return {
    id: ACCESS_PROVIDER_ID,
    name: config.label,
    // RFC 9207: an `iss` on the callback must be this one.
    issuer: config.issuer,
    accountSubject: ({ profile }) => profile.email.toLowerCase(),
    createAuthorizationURL({ state, codeVerifier, redirectURI, loginHint }) {
      // Requested scopes and extra parameters from the client are ignored:
      // the request to Access is always the same.
      return createAuthorizationURL({
        id: ACCESS_PROVIDER_ID,
        options: { clientId: config.clientId },
        authorizationEndpoint: config.authorizationEndpoint,
        state,
        codeVerifier,
        scopes: SCOPES,
        redirectURI,
        loginHint,
      });
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      const tokens = await validateAuthorizationCode({
        code,
        codeVerifier,
        redirectURI,
        options: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
        },
        tokenEndpoint: config.tokenEndpoint,
      });
      // Only the ID token is used: nothing calls Access for the user later,
      // so its access and refresh tokens aren't stored with the account.
      return { idToken: tokens.idToken, tokenType: tokens.tokenType };
    },
    async getUserInfo(tokens) {
      if (!tokens.idToken) return null;
      const identity = await verifyAccessJwt(tokens.idToken, {
        jwks: jwksClientFor(config.jwksUrl),
        issuer: config.issuer,
        audience: config.clientId,
      });
      if (!identity) return null;
      return {
        user: {
          email: identity.email,
          // Access authenticated this person with one of the team's
          // identity providers before issuing the token (and refused above
          // if the token says otherwise): the operator trusts those to
          // assert email addresses. See the runbook.
          emailVerified: true,
          name: identity.name ?? identity.email.split("@")[0],
        },
        data: { ...identity.claims, email: identity.email },
      };
    },
  };
}
