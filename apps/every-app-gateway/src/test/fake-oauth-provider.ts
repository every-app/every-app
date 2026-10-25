/**
 * A test double for an OAuth 2 provider (docs/design/2026-10-oauth-providers.md),
 * usable as the proxy's `fetchUpstream` and by a browser harness: an
 * in-memory authorize endpoint that hands out codes, a token endpoint that
 * checks PKCE S256 and the client (form or Basic), a refresh grant, a
 * revoke endpoint, and an API host that echoes the bearer it received.
 * Nothing leaves the process; `state` records every call for assertions.
 */

type FakeScopeDialect = "space" | "comma" | "google" | "none";

interface FakeOAuthProviderOptions {
  authorizeUrl: string;
  tokenUrl: string;
  /** The API host (`api.github.com`): any path on it echoes the bearer. */
  apiHost: string;
  clientId: string;
  /** Null for a public client (no secret checked). */
  clientSecret: string | null;
  /** How the token response spells `scope`: separator, or `none` to omit the field. */
  scopeDialect?: FakeScopeDialect;
  /** `expires_in` on each token answer; omitted when null (a token that never expires). */
  expiresIn?: number | null;
  /** Whether a refresh token is issued on the code exchange (default true). */
  issueRefreshToken?: boolean;
  /** Whether a refresh rotates the refresh token (default false). */
  rotateRefreshToken?: boolean;
  /** The revoke endpoint, when the provider has one. */
  revokeUrl?: string;
  /** The identity endpoint (on the API host) and what it answers. */
  identity?: { path: string; body: Record<string, unknown> };
  /** Require PKCE (default true): a code exchange without a verifier is refused. */
  requirePkce?: boolean;
}

interface FakeAuthorizeRequest {
  url: URL;
  clientId: string | null;
  redirectUri: string | null;
  scope: string | null;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  responseType: string | null;
  extra: Record<string, string>;
}

interface FakeTokenRequest {
  grantType: string | null;
  /** How the client arrived: the form body, HTTP Basic, or not at all. */
  clientVia: "form" | "basic" | "none";
  clientId: string | null;
  clientSecretPresent: boolean;
  code: string | null;
  codeVerifier: string | null;
  redirectUri: string | null;
  refreshToken: string | null;
  headers: Record<string, string>;
}

interface FakeApiRequest {
  method: string;
  url: string;
  bearer: string | null;
  headers: Record<string, string>;
}

interface IssuedCode {
  code: string;
  clientId: string;
  redirectUri: string | null;
  scopes: string[];
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  used: boolean;
}

interface IssuedToken {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  revoked: boolean;
}

interface FakeOAuthProviderState {
  authorizeRequests: FakeAuthorizeRequest[];
  tokenRequests: FakeTokenRequest[];
  apiRequests: FakeApiRequest[];
  revokeRequests: {
    token: string | null;
    clientVia: "form" | "basic" | "none";
  }[];
  codes: IssuedCode[];
  tokens: IssuedToken[];
  counters: {
    authorize: number;
    token: number;
    refresh: number;
    revoke: number;
    api: number;
  };
  /** Make the next token answer fail with this error (`invalid_grant`), once. */
  failNextToken: string | null;
  /** Make the next API answer this status, once. */
  failNextApi: number | null;
}

interface FakeOAuthProvider {
  fetch: (
    input: Request | string | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  state: FakeOAuthProviderState;
  /**
   * What a browser does at the authorize page: records the request, issues
   * a code for it, and returns the redirect URL the provider would send
   * the browser to (`redirect_uri?code=…&state=…`).
   */
  authorize: (authorizeUrl: string | URL) => URL;
  /** The scopes a token carries, by access token. */
  scopesOf: (accessToken: string) => string[] | null;
  /** Whether an access token is live (issued, not revoked). */
  accepts: (accessToken: string) => boolean;
}

let sequence = 0;
const next = (prefix: string): string =>
  `${prefix}_${(sequence += 1).toString(36)}`;

function headersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function basicAuth(
  header: string | null,
): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header)) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

async function bodyParams(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (type.includes("application/json")) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(json)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [k, v as string]),
      );
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

function splitScopes(scope: string | null): string[] {
  return (scope ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function fakeOAuthProvider(
  options: FakeOAuthProviderOptions,
): FakeOAuthProvider {
  const dialect = options.scopeDialect ?? "space";
  const expiresIn = options.expiresIn === undefined ? 3600 : options.expiresIn;
  const issueRefresh = options.issueRefreshToken ?? true;
  const rotate = options.rotateRefreshToken ?? false;
  const requirePkce = options.requirePkce ?? true;
  const authorize = new URL(options.authorizeUrl);
  const token = new URL(options.tokenUrl);
  const revoke = options.revokeUrl ? new URL(options.revokeUrl) : null;

  const state: FakeOAuthProviderState = {
    authorizeRequests: [],
    tokenRequests: [],
    apiRequests: [],
    revokeRequests: [],
    codes: [],
    tokens: [],
    counters: { authorize: 0, token: 0, refresh: 0, revoke: 0, api: 0 },
    failNextToken: null,
    failNextApi: null,
  };

  const scopeField = (scopes: string[]): Record<string, string> => {
    switch (dialect) {
      case "none":
        return {};
      case "comma":
        return { scope: scopes.join(",") };
      default:
        return { scope: scopes.join(" ") };
    }
  };

  const tokenAnswer = (issued: IssuedToken): Response =>
    Response.json({
      access_token: issued.accessToken,
      token_type: "bearer",
      ...(expiresIn === null ? {} : { expires_in: expiresIn }),
      ...(issued.refreshToken ? { refresh_token: issued.refreshToken } : {}),
      ...scopeField(issued.scopes),
    });

  const oauthError = (error: string, status = 400): Response =>
    Response.json(
      { error, error_description: `${error} (fake provider)` },
      { status },
    );

  const recordAuthorize = (url: URL): FakeAuthorizeRequest => {
    const p = url.searchParams;
    const known = new Set([
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "code_challenge",
      "code_challenge_method",
      "response_type",
    ]);
    const extra: Record<string, string> = {};
    p.forEach((value, name) => {
      if (!known.has(name)) extra[name] = value;
    });
    const request: FakeAuthorizeRequest = {
      url,
      clientId: p.get("client_id"),
      redirectUri: p.get("redirect_uri"),
      scope: p.get("scope"),
      state: p.get("state"),
      codeChallenge: p.get("code_challenge"),
      codeChallengeMethod: p.get("code_challenge_method"),
      responseType: p.get("response_type"),
      extra,
    };
    state.authorizeRequests.push(request);
    state.counters.authorize += 1;
    return request;
  };

  const browserAuthorize = (input: string | URL): URL => {
    const url = new URL(input);
    if (
      url.origin !== authorize.origin ||
      url.pathname !== authorize.pathname
    ) {
      throw new Error(`not the authorize URL: ${url.href}`);
    }
    const request = recordAuthorize(url);
    if (!request.redirectUri) throw new Error("authorize without redirect_uri");
    const back = new URL(request.redirectUri);
    if (request.clientId !== options.clientId) {
      back.searchParams.set("error", "unauthorized_client");
    } else if (request.responseType !== "code") {
      back.searchParams.set("error", "unsupported_response_type");
    } else {
      const issued: IssuedCode = {
        code: next("code"),
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        scopes: splitScopes(request.scope),
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: request.codeChallengeMethod,
        used: false,
      };
      state.codes.push(issued);
      back.searchParams.set("code", issued.code);
    }
    if (request.state) back.searchParams.set("state", request.state);
    return back;
  };

  const handleToken = async (request: Request): Promise<Response> => {
    state.counters.token += 1;
    const params = await bodyParams(request);
    const basic = basicAuth(request.headers.get("authorization"));
    const clientVia: FakeTokenRequest["clientVia"] = basic
      ? "basic"
      : params.has("client_id")
        ? "form"
        : "none";
    const clientId = basic?.id ?? params.get("client_id");
    const clientSecret = basic?.secret ?? params.get("client_secret");
    const grantType = params.get("grant_type");
    const record: FakeTokenRequest = {
      grantType,
      clientVia,
      clientId,
      clientSecretPresent: clientSecret !== null && clientSecret !== "",
      code: params.get("code"),
      codeVerifier: params.get("code_verifier"),
      redirectUri: params.get("redirect_uri"),
      refreshToken: params.get("refresh_token"),
      headers: headersOf(request.headers),
    };
    state.tokenRequests.push(record);
    if (state.failNextToken) {
      const error = state.failNextToken;
      state.failNextToken = null;
      return oauthError(error);
    }
    if (request.method !== "POST") return oauthError("invalid_request", 405);
    if (clientId !== options.clientId) return oauthError("invalid_client", 401);
    if (
      options.clientSecret !== null &&
      clientSecret !== options.clientSecret
    ) {
      return oauthError("invalid_client", 401);
    }
    if (grantType === "authorization_code") {
      const issued = state.codes.find((c) => c.code === record.code);
      if (!issued || issued.used || issued.clientId !== clientId) {
        return oauthError("invalid_grant");
      }
      if (issued.redirectUri && record.redirectUri !== issued.redirectUri) {
        return oauthError("invalid_grant");
      }
      if (issued.codeChallenge) {
        if (!record.codeVerifier) return oauthError("invalid_grant");
        const expected =
          issued.codeChallengeMethod === "S256"
            ? await s256(record.codeVerifier)
            : record.codeVerifier;
        if (expected !== issued.codeChallenge)
          return oauthError("invalid_grant");
      } else if (requirePkce) {
        return oauthError("invalid_request");
      }
      issued.used = true;
      const tokenIssued: IssuedToken = {
        accessToken: next("access"),
        refreshToken: issueRefresh ? next("refresh") : null,
        scopes: issued.scopes,
        revoked: false,
      };
      state.tokens.push(tokenIssued);
      return tokenAnswer(tokenIssued);
    }
    if (grantType === "refresh_token") {
      state.counters.refresh += 1;
      const current = state.tokens.find(
        (t) =>
          t.refreshToken !== null &&
          t.refreshToken === record.refreshToken &&
          !t.revoked,
      );
      if (!current) return oauthError("invalid_grant");
      const refreshed: IssuedToken = {
        accessToken: next("access"),
        refreshToken: rotate ? next("refresh") : current.refreshToken,
        scopes: current.scopes,
        revoked: false,
      };
      if (rotate) current.revoked = true;
      else current.accessToken = refreshed.accessToken;
      if (rotate) state.tokens.push(refreshed);
      return Response.json({
        access_token: refreshed.accessToken,
        token_type: "bearer",
        ...(expiresIn === null ? {} : { expires_in: expiresIn }),
        ...(rotate && refreshed.refreshToken
          ? { refresh_token: refreshed.refreshToken }
          : {}),
        ...scopeField(refreshed.scopes),
      });
    }
    return oauthError("unsupported_grant_type");
  };

  const handleRevoke = async (request: Request): Promise<Response> => {
    state.counters.revoke += 1;
    const params = await bodyParams(request);
    const basic = basicAuth(request.headers.get("authorization"));
    const value = params.get("token") ?? params.get("access_token");
    state.revokeRequests.push({
      token: value,
      clientVia: basic ? "basic" : params.has("client_id") ? "form" : "none",
    });
    const clientId = basic?.id ?? params.get("client_id");
    if (clientId !== options.clientId) return oauthError("invalid_client", 401);
    for (const t of state.tokens) {
      if (t.accessToken === value || t.refreshToken === value) t.revoked = true;
    }
    return new Response(null, { status: 200 });
  };

  const handleApi = (request: Request, url: URL): Response => {
    state.counters.api += 1;
    const authorization = request.headers.get("authorization");
    const bearer =
      authorization && /^bearer /i.test(authorization)
        ? authorization.slice(7).trim()
        : null;
    state.apiRequests.push({
      method: request.method,
      url: url.href,
      bearer,
      headers: headersOf(request.headers),
    });
    if (state.failNextApi !== null) {
      const status = state.failNextApi;
      state.failNextApi = null;
      return Response.json({ message: "failed on request" }, { status });
    }
    const live = bearer
      ? state.tokens.find((t) => t.accessToken === bearer && !t.revoked)
      : null;
    if (!live) {
      return Response.json(
        { message: "Bad credentials" },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="fake"' } },
      );
    }
    if (options.identity && url.pathname === options.identity.path) {
      return Response.json(options.identity.body);
    }
    return Response.json({
      ok: true,
      method: request.method,
      path: url.pathname + url.search,
      bearer,
      scopes: live.scopes,
    });
  };

  const fetchImpl = async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request =
      input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === authorize.origin &&
      url.pathname === authorize.pathname
    ) {
      // A non-browser GET of the authorize page: the provider's consent HTML.
      recordAuthorize(url);
      return new Response("<html>consent</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (url.origin === token.origin && url.pathname === token.pathname) {
      return handleToken(request);
    }
    if (
      revoke &&
      url.origin === revoke.origin &&
      url.pathname === revoke.pathname
    ) {
      return handleRevoke(request);
    }
    if (url.host === options.apiHost) return handleApi(request, url);
    return new Response(`fake provider: unknown host ${url.host}`, {
      status: 502,
    });
  };

  return {
    fetch: fetchImpl,
    state,
    authorize: browserAuthorize,
    scopesOf: (accessToken) =>
      state.tokens.find((t) => t.accessToken === accessToken)?.scopes ?? null,
    accepts: (accessToken) =>
      state.tokens.some((t) => t.accessToken === accessToken && !t.revoked),
  };
}

/** A PKCE pair for tests: a verifier and its S256 challenge. */
export async function pkcePair(
  verifier = "test-verifier-0123456789abcdefghijklmnopqrstuvwxyz",
): Promise<{
  verifier: string;
  challenge: string;
}> {
  return { verifier, challenge: await s256(verifier) };
}
