import { describe, expect, it, vi } from "vitest";
import {
  authorize,
  discover,
  linkedDevResource,
  refresh,
  registerClient,
  revoke,
  type ServerMetadata,
} from "./oauth";

const GATEWAY = "https://apps.example.com";
const metadata: ServerMetadata = {
  issuer: GATEWAY,
  authorization_endpoint: `${GATEWAY}/oauth/authorize`,
  token_endpoint: `${GATEWAY}/oauth/token`,
  revocation_endpoint: `${GATEWAY}/oauth/token`,
  registration_endpoint: `${GATEWAY}/oauth/register`,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("linked dev's OAuth client", () => {
  it("names the resource under the issuer", () => {
    expect(linkedDevResource("https://apps.example.com/some/path", "todo")).toBe(
      "https://apps.example.com/linked-dev/todo",
    );
  });

  it("discovers the server from the Gateway's origin and refuses another issuer, or no server", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === `${GATEWAY}/.well-known/oauth-authorization-server`
        ? json({
            issuer: GATEWAY,
            authorization_endpoint: `${GATEWAY}/oauth/authorize`,
            token_endpoint: `${GATEWAY}/oauth/token`,
          })
        : json({ error: "not_found" }, 404),
    );
    await expect(discover(`${GATEWAY}/apps`, fetchImpl as unknown as typeof fetch)).resolves.toMatchObject({
      issuer: GATEWAY,
      authorization_endpoint: `${GATEWAY}/oauth/authorize`,
    });
    await expect(
      discover("https://other.example.com", fetchImpl as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "LINKED_DEV_OAUTH_OFF" });
    // Every endpoint must be the issuer's own: what the browser is opened at
    // and what the code and the refresh token are posted to.
    const foreignEndpoint = vi.fn(async () =>
      json({
        issuer: GATEWAY,
        authorization_endpoint: `${GATEWAY}/oauth/authorize`,
        token_endpoint: "https://evil.example/token",
      }),
    );
    await expect(discover(GATEWAY, foreignEndpoint as unknown as typeof fetch)).rejects.toMatchObject({
      code: "LINKED_DEV_OAUTH_OFF",
      data: { endpoint: "token_endpoint" },
    });
    const schemeEndpoint = vi.fn(async () =>
      json({ issuer: GATEWAY, authorization_endpoint: "file:///etc/passwd", token_endpoint: `${GATEWAY}/t` }),
    );
    await expect(discover(GATEWAY, schemeEndpoint as unknown as typeof fetch)).rejects.toMatchObject({
      code: "LINKED_DEV_OAUTH_OFF",
    });
    const wrongIssuer = vi.fn(async () =>
      json({ issuer: "https://evil.example", token_endpoint: "https://evil.example/t" }),
    );
    await expect(discover(GATEWAY, wrongIssuer as unknown as typeof fetch)).rejects.toMatchObject({
      code: "LINKED_DEV_OAUTH_OFF",
    });
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(discover(GATEWAY, down as unknown as typeof fetch)).rejects.toMatchObject({
      code: "LINKED_DEV_GATEWAY_UNREACHABLE",
    });
  });

  it("registers a public loopback client once, and says so when registration is off", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        client_name: "everyapp dev on box",
        redirect_uris: ["http://127.0.0.1/callback"],
        token_endpoint_auth_method: "none",
      });
      return json({ client_id: "cid" }, 201);
    });
    await expect(
      registerClient(metadata, "everyapp dev on box", fetchImpl as unknown as typeof fetch),
    ).resolves.toBe("cid");
    const { registration_endpoint: _off, ...noRegistration } = metadata;
    await expect(registerClient(noRegistration, "x")).rejects.toMatchObject({
      code: "LINKED_DEV_REGISTRATION_OFF",
    });
  });

  it("authorizes with PKCE on a loopback port, checks state and iss, and exchanges the code", async () => {
    let exchanged: URLSearchParams | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(metadata.token_endpoint);
      exchanged = new URLSearchParams(String(init?.body));
      return json({
        access_token: "at",
        refresh_token: "rt",
        expires_in: 3600,
        resource: exchanged.get("resource"),
      });
    });
    const seen: string[] = [];
    const tokens = await authorize({
      metadata,
      clientId: "cid",
      resource: `${GATEWAY}/linked-dev/todo`,
      onUrl: (url) => seen.push(url),
      openBrowser: async (url) => {
        const authorizeUrl = new URL(url);
        expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(metadata.authorization_endpoint);
        expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
        expect(authorizeUrl.searchParams.get("resource")).toBe(`${GATEWAY}/linked-dev/todo`);
        expect(authorizeUrl.searchParams.get("scope")).toBeNull();
        const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
        expect(redirect.hostname).toBe("127.0.0.1");
        // A callback with the wrong state is refused and the listener stays
        // up, an `error` with the wrong state too: only this sign-in ends it.
        const wrong = await fetch(`${redirect}?code=x&state=nope&iss=${GATEWAY}`);
        expect(wrong.status).toBe(400);
        const wrongError = await fetch(`${redirect}?error=access_denied&state=nope`);
        expect(wrongError.status).toBe(400);
        // The Gateway's redirect: the browser lands on the listener.
        const ok = await fetch(
          `${redirect}?code=the-code&state=${authorizeUrl.searchParams.get("state")}&iss=${encodeURIComponent(GATEWAY)}`,
        );
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain("close this window");
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(tokens).toEqual({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      resource: `${GATEWAY}/linked-dev/todo`,
    });
    expect(seen).toHaveLength(1);
    expect(exchanged?.get("grant_type")).toBe("authorization_code");
    expect(exchanged?.get("code")).toBe("the-code");
    expect(exchanged?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(exchanged?.get("client_id")).toBe("cid");
  });

  it("reports the Gateway's refusal on the callback and a token that won't refresh", async () => {
    await expect(
      authorize({
        metadata,
        clientId: "cid",
        resource: `${GATEWAY}/linked-dev/todo`,
        onUrl: () => undefined,
        openBrowser: async (url) => {
          const authorizeUrl = new URL(url);
          const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
          await fetch(
            `${redirect}?error=access_denied&error_description=Not+allowed&state=${authorizeUrl.searchParams.get("state")}`,
          );
        },
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "LINKED_DEV_SIGNIN_FAILED", data: { error: "access_denied" } });

    const gone = vi.fn(async () => json({ error: "invalid_grant" }, 400));
    await expect(
      refresh(metadata, "cid", "rt", `${GATEWAY}/linked-dev/todo`, gone as unknown as typeof fetch),
    ).rejects.toMatchObject({ code: "LINKED_DEV_SIGNIN_FAILED", data: { error: "invalid_grant" } });

    const revoked = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get("token_type_hint")).toBe("refresh_token");
      return new Response(null, { status: 200 });
    });
    await expect(revoke(metadata, "cid", "rt", revoked as unknown as typeof fetch)).resolves.toBe(true);
  });
});
