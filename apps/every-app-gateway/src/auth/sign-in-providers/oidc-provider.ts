/**
 * The generic OpenID Connect sign-in provider (`oidc`: Okta, Entra ID,
 * Keycloak, Auth0, Google Workspace as an issuer…), built the way the
 * Cloudflare Access one is (../cloudflare-access/oidc-provider.ts) rather
 * than on Better Auth's genericOAuth plugin, which fetches the issuer's
 * discovery document when the auth instance is built, once per isolate,
 * before any request is served, and drops the provider for the isolate's
 * life when that fetch fails.
 *
 *  - Discovery (`<issuer>/.well-known/openid-configuration`) is fetched when
 *    someone starts a sign-in, cached for an hour per isolate, and must name
 *    the configured issuer; nothing is fetched when the gateway starts.
 *  - Better Auth drives the flow (`/sign-in/social`, `/callback/oidc`) with
 *    its own state, PKCE (S256) and a nonce the ID token must echo.
 *  - The ID token is verified in full (RS256 by the issuer's JWKS, issuer,
 *    audience = client id, expiry, nonce) before its claims are used; the
 *    account is keyed by `sub`.
 *  - The email is the ID token's, else the userinfo endpoint's for the same
 *    `sub`; it counts as verified only when `email_verified` is true (the
 *    membership policy refuses an unverified one: ./membership.ts).
 *  - Signing in by posting an ID token isn't offered (disableIdTokenSignIn).
 */
import { APIError } from "better-auth/api";
import {
  createAuthorizationURL,
  validateAuthorizationCode,
  type OAuth2Tokens,
  type OAuthProvider,
} from "better-auth/oauth2";
import {
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { logEvent } from "@every-app/perimeter";
import { jwksClientFor } from "../cloudflare-access/jwt";
import type { SignInProviderConfig } from "./config";

/** The claims an OIDC ID token carries that the gateway reads. */
type OidcProfile = JWTPayload & {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

const SCOPES = ["openid", "email", "profile"];
/** How long a discovery document is used before it is fetched again. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** How long a discovery or userinfo fetch may take. */
const FETCH_TIMEOUT_MS = 5000;
/** Leeway on `exp`, `nbf` and `iat` for clocks a little apart. */
const CLOCK_TOLERANCE_SECONDS = 60;

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
}

const discoveries = new Map<
  string,
  { document: Discovery; fetchedAt: number }
>();

/** Forget every cached discovery document (tests). */
export function clearOidcDiscoveryForTests(): void {
  discoveries.clear();
}

function httpsUrl(value: unknown, issuer: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    // An endpoint must be https, unless the issuer itself is a loopback one
    // (local development against a mock).
    if (
      url.protocol !== "https:" &&
      !(loopback && issuer.startsWith("http://"))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The issuer's discovery document, fetched or cached. Throws
 * SIGNIN_PROVIDER_UNAVAILABLE when it can't be had or doesn't describe
 * this issuer, so a sign-in start fails with a clear answer.
 */
async function discover(issuer: string): Promise<Discovery> {
  const cached = discoveries.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.document;
  }
  let document: Discovery;
  try {
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.issuer !== issuer) {
      throw new Error(
        `the discovery document names issuer ${String(body.issuer)}, not ${issuer}`,
      );
    }
    const authorizationEndpoint = httpsUrl(body.authorization_endpoint, issuer);
    const tokenEndpoint = httpsUrl(body.token_endpoint, issuer);
    const jwksUri = httpsUrl(body.jwks_uri, issuer);
    if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
      throw new Error(
        "the discovery document lacks an https authorization_endpoint, token_endpoint or jwks_uri",
      );
    }
    document = {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      jwksUri,
      userinfoEndpoint: httpsUrl(body.userinfo_endpoint, issuer),
    };
  } catch (error) {
    logEvent(
      "signin.discovery_failed",
      {
        issuer,
        reason: error instanceof Error ? error.message : String(error),
      },
      "error",
    );
    throw new APIError("SERVICE_UNAVAILABLE", {
      code: "SIGNIN_PROVIDER_UNAVAILABLE",
      message:
        "The sign-in provider couldn't be reached (its OpenID configuration). Try again in a moment, or ask an admin to check OIDC_SIGNIN_ISSUER.",
    });
  }
  discoveries.set(issuer, { document, fetchedAt: Date.now() });
  return document;
}

/**
 * The verified claims of an ID token from `discovery.issuer` for this
 * client, or null for any token that isn't one.
 */
async function verifyIdToken(
  token: string,
  discovery: Discovery,
  clientId: string,
  nonce: string | undefined,
): Promise<OidcProfile | null> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    return null;
  }
  const keys = await jwksClientFor(discovery.jwksUri).keysFor(header.kid);
  if (!keys) return null;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer: discovery.issuer,
      audience: clientId,
      requiredClaims: ["exp", "sub"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (error) {
    if (!(error instanceof errors.JOSEError)) throw error;
    return null;
  }
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  // The nonce the sign-in started with must come back in the token (OIDC
  // Core 3.1.3.7): a token minted for another request is refused.
  if (nonce !== undefined && payload.nonce !== nonce) return null;
  return payload as OidcProfile;
}

/** The userinfo endpoint's answer for the same subject, or null. */
async function fetchUserInfo(
  discovery: Discovery,
  accessToken: string,
  sub: string,
): Promise<Record<string, unknown> | null> {
  if (!discovery.userinfoEndpoint) return null;
  try {
    const response = await fetch(discovery.userinfoEndpoint, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    // OIDC Core 5.3.2: a userinfo answer for another subject is refused.
    return body.sub === sub ? body : null;
  } catch {
    return null;
  }
}

function emailOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  return email && email.includes("@") && !/\s/.test(email) ? email : null;
}

export function createOidcSignInProvider(
  config: SignInProviderConfig & { issuer: string },
): OAuthProvider<OidcProfile> {
  const { issuer, clientId, clientSecret } = config;
  return {
    id: "oidc",
    name: config.label,
    // RFC 9207: an `iss` on the callback must be this one.
    issuer,
    accountSubject: ({ profile }) => profile.sub,
    requiresIdTokenNonce: true,
    async createAuthorizationURL({
      state,
      codeVerifier,
      redirectURI,
      loginHint,
      idTokenNonce,
    }) {
      // Requested scopes and extra parameters from the client are ignored:
      // the request to the issuer is always the same.
      const discovery = await discover(issuer);
      return createAuthorizationURL({
        id: "oidc",
        options: { clientId },
        authorizationEndpoint: discovery.authorizationEndpoint,
        state,
        codeVerifier,
        scopes: SCOPES,
        redirectURI,
        loginHint,
        nonce: idTokenNonce,
      });
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      const discovery = await discover(issuer);
      const tokens = await validateAuthorizationCode({
        code,
        codeVerifier,
        redirectURI,
        options: { clientId, clientSecret },
        tokenEndpoint: discovery.tokenEndpoint,
      });
      // The ID token and, for the userinfo endpoint, the access token:
      // nothing calls the issuer for the user later, so no refresh token
      // is kept with the account.
      return {
        idToken: tokens.idToken,
        accessToken: tokens.accessToken,
        tokenType: tokens.tokenType,
      };
    },
    async getUserInfo(
      tokens: OAuth2Tokens & { expectedIdTokenNonce?: string },
    ) {
      if (!tokens.idToken) return null;
      const discovery = await discover(issuer);
      const claims = await verifyIdToken(
        tokens.idToken,
        discovery,
        clientId,
        tokens.expectedIdTokenNonce,
      );
      if (!claims) return null;
      let email = emailOf(claims.email);
      let emailVerified = claims.email_verified === true;
      let name = typeof claims.name === "string" ? claims.name.trim() : "";
      let image =
        typeof claims.picture === "string" ? claims.picture : undefined;
      if (!email && tokens.accessToken) {
        const info = await fetchUserInfo(
          discovery,
          tokens.accessToken,
          claims.sub,
        );
        if (info) {
          email = emailOf(info.email);
          emailVerified = info.email_verified === true;
          if (!name && typeof info.name === "string") name = info.name.trim();
          if (!image && typeof info.picture === "string") image = info.picture;
        }
      }
      if (!email) return null;
      return {
        user: {
          email: email.toLowerCase(),
          emailVerified,
          name: name || email.split("@")[0]!,
          image,
        },
        data: { ...claims, email: email.toLowerCase() },
      };
    },
    options: {
      clientId,
      clientSecret,
      // One flow only: the redirect through the issuer, never a posted
      // ID token.
      disableIdTokenSignIn: true,
    },
  };
}
