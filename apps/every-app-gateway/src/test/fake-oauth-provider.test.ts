import { describe, expect, it } from "vitest";
import { fakeOAuthProvider, pkcePair } from "./fake-oauth-provider";

const options = {
  authorizeUrl: "https://fake.example/login/oauth/authorize",
  tokenUrl: "https://fake.example/login/oauth/access_token",
  revokeUrl: "https://fake.example/login/oauth/revoke",
  apiHost: "api.fake.example",
  clientId: "client-1",
  clientSecret: "secret-1",
  identity: { path: "/user", body: { login: "ben", id: 42 } },
};

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

async function startFlow(
  provider: ReturnType<typeof fakeOAuthProvider>,
  challenge: string,
) {
  const url = new URL(options.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "client-1");
  url.searchParams.set(
    "redirect_uri",
    "https://gw.example/connect/fake/callback",
  );
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", "st-1");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "false");
  const back = provider.authorize(url);
  return { back, code: back.searchParams.get("code")! };
}

describe("the fake OAuth provider", () => {
  it("runs a code exchange with PKCE and the client in the form, then serves the API", async () => {
    const provider = fakeOAuthProvider(options);
    const { verifier, challenge } = await pkcePair();
    const { back, code } = await startFlow(provider, challenge);
    expect(back.origin + back.pathname).toBe(
      "https://gw.example/connect/fake/callback",
    );
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(provider.state.authorizeRequests[0]?.extra).toEqual({
      allow_signup: "false",
    });

    const answer = await provider.fetch(
      options.tokenUrl,
      form({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://gw.example/connect/fake/callback",
        code_verifier: verifier,
        client_id: "client-1",
        client_secret: "secret-1",
      }),
    );
    expect(answer.status).toBe(200);
    const json = (await answer.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      token_type: "bearer",
      expires_in: 3600,
      scope: "read:user repo",
    });
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    expect(provider.state.tokenRequests[0]).toMatchObject({
      clientVia: "form",
      grantType: "authorization_code",
    });

    const api = await provider.fetch(
      `https://api.fake.example/repos?per_page=1`,
      {
        headers: { authorization: `Bearer ${json.access_token as string}` },
      },
    );
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({
      ok: true,
      path: "/repos?per_page=1",
      scopes: ["read:user", "repo"],
    });
    const me = await provider.fetch(`https://api.fake.example/user`, {
      headers: { authorization: `Bearer ${json.access_token as string}` },
    });
    expect(await me.json()).toEqual({ login: "ben", id: 42 });
    expect(provider.state.counters).toMatchObject({
      authorize: 1,
      token: 1,
      api: 2,
    });

    // A code is used once.
    const again = await provider.fetch(
      options.tokenUrl,
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "client-1",
        client_secret: "secret-1",
        redirect_uri: "https://gw.example/connect/fake/callback",
      }),
    );
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a wrong verifier, a wrong client, a missing verifier, and an unknown grant", async () => {
    const provider = fakeOAuthProvider(options);
    const { challenge } = await pkcePair();
    const common = {
      grant_type: "authorization_code",
      redirect_uri: "https://gw.example/connect/fake/callback",
    };
    const { code: c1 } = await startFlow(provider, challenge);
    const wrongVerifier = await provider.fetch(
      options.tokenUrl,
      form({
        ...common,
        code: c1,
        code_verifier: "nope",
        client_id: "client-1",
        client_secret: "secret-1",
      }),
    );
    expect(await wrongVerifier.json()).toMatchObject({
      error: "invalid_grant",
    });
    const { code: c2 } = await startFlow(provider, challenge);
    const wrongClient = await provider.fetch(
      options.tokenUrl,
      form({
        ...common,
        code: c2,
        code_verifier: "x",
        client_id: "client-1",
        client_secret: "wrong",
      }),
    );
    expect(wrongClient.status).toBe(401);
    const { code: c3 } = await startFlow(provider, challenge);
    const noVerifier = await provider.fetch(
      options.tokenUrl,
      form({
        ...common,
        code: c3,
        client_id: "client-1",
        client_secret: "secret-1",
      }),
    );
    expect(await noVerifier.json()).toMatchObject({ error: "invalid_grant" });
    const unknown = await provider.fetch(
      options.tokenUrl,
      form({
        grant_type: "password",
        client_id: "client-1",
        client_secret: "secret-1",
      }),
    );
    expect(await unknown.json()).toMatchObject({
      error: "unsupported_grant_type",
    });
    const elsewhere = await provider.fetch("https://other.example/x");
    expect(elsewhere.status).toBe(502);
  });

  it("takes the client over HTTP Basic, refreshes, rotates when told, revokes, and spells scope per dialect", async () => {
    const provider = fakeOAuthProvider({
      ...options,
      scopeDialect: "comma",
      rotateRefreshToken: true,
      expiresIn: null,
    });
    const { verifier, challenge } = await pkcePair(
      "another-verifier-0123456789abcdefghijklmnop",
    );
    const { code } = await startFlow(provider, challenge);
    const basic = `Basic ${btoa("client-1:secret-1")}`;
    const first = await provider.fetch(options.tokenUrl, {
      ...form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: "https://gw.example/connect/fake/callback",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
    });
    const json1 = (await first.json()) as Record<string, string>;
    expect(json1.scope).toBe("read:user,repo");
    expect(json1).not.toHaveProperty("expires_in");
    expect(provider.state.tokenRequests[0]?.clientVia).toBe("basic");

    const refreshed = await provider.fetch(options.tokenUrl, {
      ...form({
        grant_type: "refresh_token",
        refresh_token: json1.refresh_token!,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
    });
    const json2 = (await refreshed.json()) as Record<string, string>;
    expect(json2.access_token).not.toBe(json1.access_token);
    expect(json2.refresh_token).toBeDefined();
    expect(json2.refresh_token).not.toBe(json1.refresh_token);
    expect(provider.accepts(json1.access_token!)).toBe(false);
    expect(provider.accepts(json2.access_token!)).toBe(true);
    expect(provider.state.counters.refresh).toBe(1);

    // The old refresh token is dead after rotation.
    const stale = await provider.fetch(options.tokenUrl, {
      ...form({
        grant_type: "refresh_token",
        refresh_token: json1.refresh_token!,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
    });
    expect(await stale.json()).toMatchObject({ error: "invalid_grant" });

    provider.state.failNextToken = "invalid_grant";
    const failed = await provider.fetch(options.tokenUrl, {
      ...form({
        grant_type: "refresh_token",
        refresh_token: json2.refresh_token!,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic,
      },
    });
    expect(failed.status).toBe(400);

    const revoked = await provider.fetch(options.revokeUrl, {
      ...form({ token: json2.access_token!, client_id: "client-1" }),
    });
    expect(revoked.status).toBe(200);
    expect(provider.accepts(json2.access_token!)).toBe(false);
    const api = await provider.fetch("https://api.fake.example/user", {
      headers: { authorization: `Bearer ${json2.access_token!}` },
    });
    expect(api.status).toBe(401);
    expect(provider.state.revokeRequests).toEqual([
      { token: json2.access_token, clientVia: "form" },
    ]);
  });

  it("omits scope for the none dialect and serves a public client without a secret", async () => {
    const provider = fakeOAuthProvider({
      ...options,
      clientSecret: null,
      scopeDialect: "none",
      issueRefreshToken: false,
    });
    const { verifier, challenge } = await pkcePair();
    const { code } = await startFlow(provider, challenge);
    const answer = await provider.fetch(
      options.tokenUrl,
      form({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: "client-1",
        redirect_uri: "https://gw.example/connect/fake/callback",
      }),
    );
    const json = (await answer.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("scope");
    expect(json).not.toHaveProperty("refresh_token");
    expect(provider.scopesOf(json.access_token as string)).toEqual([
      "read:user",
      "repo",
    ]);
    provider.state.failNextApi = 503;
    const api = await provider.fetch("https://api.fake.example/x", {
      headers: { authorization: `Bearer ${json.access_token as string}` },
    });
    expect(api.status).toBe(503);
  });
});
