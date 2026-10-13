/**
 * A stand-in for Cloudflare Access in tests: the team domain's signing keys
 * (`/cdn-cgi/access/certs`) with outer-ring assertions signed by them, and an
 * Access for SaaS OIDC application (authorization, token and JWKS
 * endpoints) that checks what a real one would: the client, its secret, the
 * redirect URI, and PKCE (S256).
 *
 * Install its `fetch` with `vi.stubGlobal("fetch", access.fetch)`; the test
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

const TEAM_DOMAIN = "https://acme.cloudflareaccess.com";
const OUTER_RING_AUD =
  "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
/** The AUD of a separate Access application on the apps' hosts. */
export const APPS_AUD =
  "0b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b";
export const OIDC_CLIENT_ID = "9f2c1e0d7b6a5f4e3d2c1b0a9f8e7d6c";
const OIDC_CLIENT_SECRET = "access-client-secret";
const OIDC_ISSUER = `${TEAM_DOMAIN}/cdn-cgi/access/sso/oidc/${OIDC_CLIENT_ID}`;

/** The Worker secrets that point the gateway at this mock. */
export const MOCK_ACCESS_ENV = {
  oidc: {
    CLOUDFLARE_ACCESS_OIDC_ISSUER: OIDC_ISSUER,
    CLOUDFLARE_ACCESS_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
    CLOUDFLARE_ACCESS_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
    CLOUDFLARE_ACCESS_OIDC_LABEL: "Company SSO",
  },
  outerRing: {
    CLOUDFLARE_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com",
    CLOUDFLARE_ACCESS_AUD: OUTER_RING_AUD,
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

/** Who signs in at the mock, and anything to change in the token. */
export interface MockIdentity {
  email: string;
  name?: string;
  /** Extra or replaced ID-token / assertion claims. */
  claims?: JWTPayload;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  identity: MockIdentity;
}

export async function createMockAccess() {
  const teamKey = await signingKey("team-key-1");
  const oidcKey = await signingKey("oidc-key-1");
  const codes = new Map<string, PendingCode>();
  const calls = { certs: 0, jwks: 0, token: 0 };
  const state = { jwksDown: false };

  /** Sign as Access would; `claims` may replace `iss`, `aud` or `exp`. */
  function sign(
    key: SigningKey,
    claims: JWTPayload,
    issuer: string,
    audience: string | string[],
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

  /** The `Cf-Access-Jwt-Assertion` the outer ring would add for this person. */
  function assertion(identity: MockIdentity): Promise<string> {
    return sign(
      teamKey,
      {
        email: identity.email,
        sub: crypto.randomUUID(),
        type: "app",
        identity_nonce: "nonce",
        country: "US",
        ...identity.claims,
      },
      TEAM_DOMAIN,
      [OUTER_RING_AUD],
    );
  }

  /**
   * Play the browser at the authorization endpoint: check the request the
   * gateway built, "log in" as `identity`, and return the redirect back to
   * the gateway (its callback URL with `code` and `state`).
   */
  function authorize(authorizationUrl: string, identity: MockIdentity): URL {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${OIDC_ISSUER}/authorization`) {
      throw new Error(`not the authorization endpoint: ${url}`);
    }
    const params = url.searchParams;
    if (params.get("client_id") !== OIDC_CLIENT_ID) {
      throw new Error("unknown client_id");
    }
    if (params.get("response_type") !== "code") {
      throw new Error("response_type must be code");
    }
    if (params.get("code_challenge_method") !== "S256") {
      throw new Error("PKCE (S256) is required");
    }
    const redirectUri = params.get("redirect_uri");
    const state = params.get("state");
    const codeChallenge = params.get("code_challenge");
    if (!redirectUri || !state || !codeChallenge) {
      throw new Error("missing redirect_uri, state or code_challenge");
    }
    const code = `code-${crypto.randomUUID()}`;
    codes.set(code, {
      clientId: OIDC_CLIENT_ID,
      redirectUri,
      codeChallenge,
      identity,
    });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", state);
    return back;
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function token(request: Request): Promise<Response> {
    calls.token += 1;
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
    if (clientId !== OIDC_CLIENT_ID || clientSecret !== OIDC_CLIENT_SECRET) {
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
      pending.redirectUri !== form.get("redirect_uri") ||
      pending.codeChallenge !== (await s256(form.get("code_verifier") ?? ""))
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
    const { identity } = pending;
    const idToken = await sign(
      oidcKey,
      {
        email: identity.email,
        name: identity.name ?? "Access User",
        sub: crypto.randomUUID(),
        ...identity.claims,
      },
      OIDC_ISSUER,
      OIDC_CLIENT_ID,
    );
    return json({
      access_token: `access-token-${crypto.randomUUID()}`,
      token_type: "Bearer",
      expires_in: 600,
      id_token: idToken,
    });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.origin}${url.pathname}`;
    if (path === `${TEAM_DOMAIN}/cdn-cgi/access/certs`) {
      calls.certs += 1;
      if (state.jwksDown) return json({ error: "unavailable" }, 503);
      return json({ keys: [teamKey.jwk], public_cert: {}, public_certs: [] });
    }
    if (path === `${OIDC_ISSUER}/jwks`) {
      calls.jwks += 1;
      if (state.jwksDown) return json({ error: "unavailable" }, 503);
      return json({ keys: [oidcKey.jwk] });
    }
    if (path === `${OIDC_ISSUER}/token` && request.method === "POST") {
      return token(request);
    }
    return new Response("not found", { status: 404 });
  }

  return {
    /** A `fetch` that answers for the mock and 404s everything else. */
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      handle(new Request(input, init)),
    assertion,
    authorize,
    /** Sign an ID token as the OIDC application would (for posted-token tests). */
    idToken: (identity: MockIdentity) =>
      sign(
        oidcKey,
        { email: identity.email, ...identity.claims },
        OIDC_ISSUER,
        OIDC_CLIENT_ID,
      ),
    calls,
    state,
  };
}

export type MockAccess = Awaited<ReturnType<typeof createMockAccess>>;
