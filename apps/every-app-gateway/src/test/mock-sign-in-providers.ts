/**
 * Stand-ins for the sign-in providers in tests: a generic OpenID Connect
 * issuer (discovery, authorization, token, JWKS and userinfo endpoints),
 * Google (its real endpoint URLs, answered here) and GitHub (the token
 * endpoint and the user and emails APIs). Each checks what a real one
 * would: the client, its secret, the redirect URI, PKCE (S256) and, for
 * OIDC, that the nonce the sign-in started with goes back in the ID token.
 *
 * Install its `fetch` with `vi.stubGlobal("fetch", mock.fetch)`; the test
 * plays the browser at the authorization endpoint with `authorize()`.
 */
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";

const OIDC_ISSUER = "https://sso.acme.example";
const OIDC_CLIENT_ID = "acme-gateway";
const OIDC_CLIENT_SECRET = "oidc-client-secret";

const GOOGLE_CLIENT_ID =
  "1234567890-abcdefghijklmnop.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "GOCSPX-google-client-secret";
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUER = "https://accounts.google.com";

const CLOUDFLARE_CLIENT_ID = "cf-oauth-client-id";
const CLOUDFLARE_CLIENT_SECRET = "cf-oauth-client-secret";
const CLOUDFLARE_AUTHORIZE = "https://dash.cloudflare.com/oauth2/auth";
const CLOUDFLARE_TOKEN = "https://dash.cloudflare.com/oauth2/token";
const CLOUDFLARE_USER = "https://api.cloudflare.com/client/v4/user";

const GITHUB_CLIENT_ID = "Iv1.github-client-id";
const GITHUB_CLIENT_SECRET = "github-client-secret";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

/** The Worker secrets that point the gateway at these mocks. */
export const MOCK_SIGN_IN_ENV = {
  oidc: {
    OIDC_SIGNIN_ISSUER: OIDC_ISSUER,
    OIDC_SIGNIN_CLIENT_ID: OIDC_CLIENT_ID,
    OIDC_SIGNIN_CLIENT_SECRET: OIDC_CLIENT_SECRET,
    OIDC_SIGNIN_LABEL: "Acme SSO",
  },
  google: {
    GOOGLE_SIGNIN_CLIENT_ID: GOOGLE_CLIENT_ID,
    GOOGLE_SIGNIN_CLIENT_SECRET: GOOGLE_CLIENT_SECRET,
  },
  github: {
    GITHUB_SIGNIN_CLIENT_ID: GITHUB_CLIENT_ID,
    GITHUB_SIGNIN_CLIENT_SECRET: GITHUB_CLIENT_SECRET,
  },
  cloudflare: {
    CLOUDFLARE_SIGNIN_CLIENT_ID: CLOUDFLARE_CLIENT_ID,
    CLOUDFLARE_SIGNIN_CLIENT_SECRET: CLOUDFLARE_CLIENT_SECRET,
  },
} as const;

type SigningKey = { privateKey: CryptoKey; jwk: JWK };

async function signingKey(kid: string): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" },
  };
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

/** Who signs in at the mock, and anything to change in what it says. */
export interface MockSignInIdentity {
  email: string;
  name?: string;
  /** The provider's stable subject (random by default). */
  sub?: string;
  /** Whether the provider says the email is verified (true by default). */
  emailVerified?: boolean;
  /** Extra or replaced ID-token claims. */
  claims?: JWTPayload;
  /** OIDC only: leave the email out of the ID token (userinfo has it). */
  emailInUserInfoOnly?: boolean;
}

interface PendingCode {
  provider: MockProviderId;
  redirectUri: string;
  codeChallenge: string | null;
  nonce: string | null;
  identity: MockSignInIdentity;
}

type MockProviderId = "oidc" | "google" | "github" | "cloudflare";

export async function createMockSignInProviders() {
  const oidcKey = await signingKey("oidc-key-1");
  const googleKey = await signingKey("google-key-1");
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, MockSignInIdentity>();
  const calls = { discovery: 0, jwks: 0, token: 0, userinfo: 0, certs: 0 };
  const state = {
    discoveryDown: false,
    jwksDown: false,
    /** Answer discovery with another issuer (a misconfigured setting). */
    discoveryIssuer: OIDC_ISSUER,
    /** Sign Google's ID token with the OIDC key (an unknown key to Google). */
    googleWrongKey: false,
  };

  function sign(
    key: SigningKey,
    claims: JWTPayload,
    issuer: string,
    audience: string,
  ): Promise<string> {
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: issuer,
      aud: audience,
      iat: issuedAt,
      exp: issuedAt + 600,
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: key.jwk.kid! })
      .sign(key.privateKey);
  }

  const clients: Record<
    MockProviderId,
    { id: string; secret: string; authorize: string; token: string }
  > = {
    oidc: {
      id: OIDC_CLIENT_ID,
      secret: OIDC_CLIENT_SECRET,
      authorize: `${OIDC_ISSUER}/authorize`,
      token: `${OIDC_ISSUER}/token`,
    },
    google: {
      id: GOOGLE_CLIENT_ID,
      secret: GOOGLE_CLIENT_SECRET,
      authorize: GOOGLE_AUTHORIZE,
      token: GOOGLE_TOKEN,
    },
    github: {
      id: GITHUB_CLIENT_ID,
      secret: GITHUB_CLIENT_SECRET,
      authorize: GITHUB_AUTHORIZE,
      token: GITHUB_TOKEN,
    },
    cloudflare: {
      id: CLOUDFLARE_CLIENT_ID,
      secret: CLOUDFLARE_CLIENT_SECRET,
      authorize: CLOUDFLARE_AUTHORIZE,
      token: CLOUDFLARE_TOKEN,
    },
  };

  /**
   * Play the browser at a provider's authorization endpoint: check the
   * request the gateway built, "log in" as `identity`, and return the
   * redirect back to the gateway (its callback URL with `code` and `state`).
   */
  function authorize(
    authorizationUrl: string,
    identity: MockSignInIdentity,
  ): { provider: MockProviderId; back: URL; scopes: string[] } {
    const url = new URL(authorizationUrl);
    const endpoint = `${url.origin}${url.pathname}`;
    const provider = (Object.keys(clients) as MockProviderId[]).find(
      (id) => clients[id].authorize === endpoint,
    );
    if (!provider) throw new Error(`not an authorization endpoint: ${url}`);
    const client = clients[provider];
    const params = url.searchParams;
    if (params.get("client_id") !== client.id) {
      throw new Error(`${provider}: unknown client_id`);
    }
    if (params.get("response_type") !== "code") {
      throw new Error(`${provider}: response_type must be code`);
    }
    const redirectUri = params.get("redirect_uri");
    const stateParam = params.get("state");
    const codeChallenge = params.get("code_challenge");
    if (!redirectUri || !stateParam) {
      throw new Error(`${provider}: missing redirect_uri or state`);
    }
    if (provider !== "github") {
      if (params.get("code_challenge_method") !== "S256" || !codeChallenge) {
        throw new Error(`${provider}: PKCE (S256) is required`);
      }
    }
    const nonce = params.get("nonce");
    if (provider === "oidc" && !nonce) {
      throw new Error("oidc: a nonce is required");
    }
    const code = `code-${crypto.randomUUID()}`;
    codes.set(code, {
      provider,
      redirectUri,
      codeChallenge,
      nonce,
      identity,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", stateParam);
    if (provider === "oidc") back.searchParams.set("iss", OIDC_ISSUER);
    return {
      provider,
      back,
      scopes: (params.get("scope") ?? "").split(/\s+/).filter(Boolean),
    };
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function idTokenFor(
    pending: PendingCode,
    key: SigningKey,
    issuer: string,
    audience: string,
  ): Promise<string> {
    const { identity } = pending;
    const claims: JWTPayload = {
      sub: identity.sub ?? `sub-${identity.email}`,
      name: identity.name ?? "Provider User",
      ...(identity.emailInUserInfoOnly
        ? {}
        : {
            email: identity.email,
            email_verified: identity.emailVerified ?? true,
          }),
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
      ...identity.claims,
    };
    return sign(key, claims, issuer, audience);
  }

  async function token(
    provider: MockProviderId,
    request: Request,
  ): Promise<Response> {
    calls.token += 1;
    const client = clients[provider];
    const form = new URLSearchParams(await request.text());
    let clientId = form.get("client_id");
    let clientSecret = form.get("client_secret");
    const basic = request.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      [clientId, clientSecret] = Buffer.from(basic.slice(6), "base64")
        .toString()
        .split(":")
        .map(decodeURIComponent);
    }
    if (clientId !== client.id || clientSecret !== client.secret) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") !== "authorization_code") {
      return json({ error: "unsupported_grant_type" }, 400);
    }
    const code = form.get("code") ?? "";
    const pending = codes.get(code);
    codes.delete(code);
    if (
      !pending ||
      pending.provider !== provider ||
      pending.redirectUri !== form.get("redirect_uri") ||
      (pending.codeChallenge !== null &&
        pending.codeChallenge !== (await s256(form.get("code_verifier") ?? "")))
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
    const accessToken = `at-${provider}-${crypto.randomUUID()}`;
    accessTokens.set(accessToken, pending.identity);
    if (provider === "github") {
      return json({
        access_token: accessToken,
        token_type: "bearer",
        scope: "read:user,user:email",
      });
    }
    if (provider === "cloudflare") {
      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user-details.read",
      });
    }
    const idToken =
      provider === "oidc"
        ? await idTokenFor(pending, oidcKey, OIDC_ISSUER, OIDC_CLIENT_ID)
        : await idTokenFor(
            pending,
            state.googleWrongKey ? oidcKey : googleKey,
            GOOGLE_ISSUER,
            GOOGLE_CLIENT_ID,
          );
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 600,
      id_token: idToken,
    });
  }

  function bearerIdentity(request: Request): MockSignInIdentity | null {
    const header = request.headers.get("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "");
    return accessTokens.get(token) ?? null;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.origin}${url.pathname}`;

    // The OIDC issuer.
    if (path === `${OIDC_ISSUER}/.well-known/openid-configuration`) {
      calls.discovery += 1;
      if (state.discoveryDown) return json({ error: "unavailable" }, 503);
      return json({
        issuer: state.discoveryIssuer,
        authorization_endpoint: `${OIDC_ISSUER}/authorize`,
        token_endpoint: `${OIDC_ISSUER}/token`,
        jwks_uri: `${OIDC_ISSUER}/jwks`,
        userinfo_endpoint: `${OIDC_ISSUER}/userinfo`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    }
    if (path === `${OIDC_ISSUER}/jwks`) {
      calls.jwks += 1;
      if (state.jwksDown) return json({ error: "unavailable" }, 503);
      return json({ keys: [oidcKey.jwk] });
    }
    if (path === `${OIDC_ISSUER}/token` && request.method === "POST") {
      return token("oidc", request);
    }
    if (path === `${OIDC_ISSUER}/userinfo`) {
      calls.userinfo += 1;
      const identity = bearerIdentity(request);
      if (!identity) return json({ error: "invalid_token" }, 401);
      return json({
        sub: identity.sub ?? `sub-${identity.email}`,
        email: identity.email,
        email_verified: identity.emailVerified ?? true,
        name: identity.name ?? "Provider User",
      });
    }

    // Google.
    if (path === GOOGLE_TOKEN && request.method === "POST") {
      return token("google", request);
    }
    if (path === GOOGLE_CERTS) {
      calls.certs += 1;
      return json({ keys: [googleKey.jwk] });
    }

    // Cloudflare: the dashboard's OAuth server and the API's /user.
    if (path === CLOUDFLARE_TOKEN && request.method === "POST") {
      return token("cloudflare", request);
    }
    if (path === CLOUDFLARE_USER) {
      const identity = bearerIdentity(request);
      if (!identity) {
        return json({ success: false, errors: [{ code: 10000 }] }, 401);
      }
      return json({
        success: true,
        errors: [],
        result: {
          id: identity.sub ?? "7c5dae5552338874e5053f2534d2767a",
          email: identity.email,
          first_name: identity.name?.split(" ")[0] ?? null,
          last_name: identity.name?.split(" ").slice(1).join(" ") || null,
          suspended: false,
        },
      });
    }

    // GitHub.
    if (path === GITHUB_TOKEN && request.method === "POST") {
      return token("github", request);
    }
    if (path === "https://api.github.com/user") {
      const identity = bearerIdentity(request);
      if (!identity) return json({ message: "Bad credentials" }, 401);
      return json({
        id: Number.parseInt(identity.sub ?? "4242", 10) || 4242,
        login: identity.name?.toLowerCase().replace(/\s+/g, "") ?? "octocat",
        name: identity.name ?? "Octo Cat",
        avatar_url: "https://avatars.example/octocat",
        // GitHub's public email: only when the person made one public.
        email: null,
      });
    }
    if (path === "https://api.github.com/user/emails") {
      const identity = bearerIdentity(request);
      if (!identity) return json({ message: "Bad credentials" }, 401);
      return json([
        {
          email: identity.email,
          primary: true,
          verified: identity.emailVerified ?? true,
          visibility: "private",
        },
        {
          email: "other@users.noreply.github.com",
          primary: false,
          verified: true,
          visibility: null,
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  }

  return {
    /** A `fetch` that answers for the mocks and 404s everything else. */
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input, init)),
    authorize,
    calls,
    state,
  };
}

export type MockSignInProviders = Awaited<
  ReturnType<typeof createMockSignInProviders>
>;
