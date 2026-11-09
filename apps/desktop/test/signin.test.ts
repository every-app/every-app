import { isSignInEndpoint } from "../src/main/auth/url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/main/auth/service";
import { OAuthAuthProvider } from "../src/main/auth/providers";
import { OAuthClient, OAuthError, type OAuthGrant } from "../src/main/auth/oauth";
import { CLIENT_MAX_IDLE_MS } from "../src/main/auth/signin";
import { SecretStore } from "../src/main/auth/store";
import { FakeServer } from "./fakeServer";
import { fakeCipher, tempStore } from "./helpers";
import { readFileSync } from "node:fs";

let fake: FakeServer;
beforeEach(async () => {
  fake = await new FakeServer().start();
});
afterEach(async () => {
  await fake.stop();
});

/** The system browser: follows the authorize endpoint, then loads the loopback redirect. */
const browser = (opened: string[] = []) => async (url: string) => {
  opened.push(url);
  await fetch(fake.authorize(url));
};

function service(store = tempStore().store, opened: string[] = []) {
  return new AuthService({ store, openBrowser: browser(opened), signInTimeoutMs: 5000 });
}

describe("Sign in with Every App", () => {
  it("discovers, registers once, exchanges with PKCE and resource, and stores the grant encrypted", async () => {
    const { store, path } = tempStore();
    const opened: string[] = [];
    const auth = service(store, opened);
    await auth.signIn(fake.origin);
    expect(auth.state.status).toBe("signedIn");
    expect(auth.state.method).toBe("oauth");
    expect(auth.state.email).toBe("ben@example.com");
    const registers = fake.requests.filter((r) => r.path === "/gw/register");
    expect(registers).toHaveLength(1);
    const reg = JSON.parse(registers[0]!.body);
    expect(reg).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: ["http://127.0.0.1/callback"], client_name: "Every App" });
    expect(reg.scope).toBeUndefined();
    const authorize = new URL(opened[0]!);
    expect(authorize.searchParams.get("resource")).toBe(fake.origin);
    expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorize.searchParams.has("scope")).toBe(false);
    const token = new URLSearchParams(fake.requests.find((r) => r.path === "/gw/token")!.body);
    expect(token.get("resource")).toBe(fake.origin);
    expect(token.get("code_verifier")).toBeTruthy();
    expect(token.has("scope")).toBe(false);
    // Encrypted on disk, readable back.
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("refresh");
    const again = new SecretStore(path, fakeCipher);
    again.load();
    expect(again.credentials?.kind).toBe("oauth");
    expect(again.entry(fake.issuer)?.clientId).toMatch(/^client_/);
  });

  it("reuses the cached client on the next sign-in", async () => {
    const { store } = tempStore();
    await service(store).signIn(fake.origin);
    await service(store).signIn(fake.origin);
    expect(fake.requests.filter((r) => r.path === "/gw/register")).toHaveLength(1);
  });

  it("re-registers when the callback says invalid_client", async () => {
    const { store } = tempStore();
    store.save("client_gone", fake.issuer, Date.now());
    const auth = service(store);
    await auth.signIn(fake.origin);
    expect(auth.state.status).toBe("signedIn");
    expect(fake.requests.filter((r) => r.path === "/gw/register")).toHaveLength(1);
    expect(store.entry(fake.issuer)?.clientId).not.toBe("client_gone");
  });

  it("re-registers when the token endpoint says invalid_client", async () => {
    const { store } = tempStore();
    await service(store).signIn(fake.origin);
    fake.tokenErrors.push({ status: 401, error: "invalid_client" });
    const auth = service(store);
    await auth.signIn(fake.origin);
    expect(auth.state.status).toBe("signedIn");
    expect(fake.requests.filter((r) => r.path === "/gw/register")).toHaveLength(2);
  });

  it("replaces a client unused for 50 days before the browser opens", async () => {
    const { store } = tempStore();
    await service(store).signIn(fake.origin);
    const old = store.entry(fake.issuer)!;
    store.save(old.clientId, fake.issuer, Date.now() - CLIENT_MAX_IDLE_MS - 1000);
    await service(store).signIn(fake.origin);
    expect(store.entry(fake.issuer)!.clientId).not.toBe(old.clientId);
  });

  it("refuses a resource that isn't the app, a Gateway with another issuer, and no S256", async () => {
    fake.resourceOverride = "https://evil.example.com";
    let auth = service();
    await auth.signIn(fake.origin);
    expect(auth.state.status).toBe("signedOut");
    expect(auth.state.error).toMatch(/says it is https:\/\/evil/);

    fake.resourceOverride = undefined;
    fake.issuerOverride = "https://other.example.com";
    auth = service();
    await auth.signIn(fake.origin);
    expect(auth.state.error).toMatch(/calls itself/);

    fake.issuerOverride = undefined;
    fake.challengeMethods = ["plain"];
    auth = service();
    await auth.signIn(fake.origin);
    expect(auth.state.error).toMatch(/PKCE/);
  });

  it("refuses a token for another resource", async () => {
    fake.echoResource = "https://other.example.com";
    const auth = service();
    await auth.signIn(fake.origin);
    expect(auth.state.status).toBe("signedOut");
    expect(auth.state.error).toMatch(/token is for https:\/\/other/);
  });

  it("can be cancelled", async () => {
    const auth = new AuthService({ store: tempStore().store, openBrowser: () => {}, signInTimeoutMs: 5000 });
    const p = auth.signIn(fake.origin);
    await new Promise((r) => setTimeout(r, 50));
    expect(auth.state.status).toBe("signingIn");
    auth.cancelSignIn();
    await p;
    expect(auth.state.status).toBe("signedOut");
    expect(auth.state.error).toBeUndefined();
  });

  it("signs out by revoking the refresh token", async () => {
    const { store } = tempStore();
    const auth = service(store);
    await auth.signIn(fake.origin);
    const grant = (store.credentials as { grant: OAuthGrant }).grant;
    await auth.signOut();
    expect(fake.revoked).toEqual([grant.refreshToken]);
    expect(store.credentials).toBeUndefined();
    expect(auth.state.status).toBe("signedOut");
  });
});

describe("refresh and rotation", () => {
  async function signedIn() {
    const { store } = tempStore();
    const auth = service(store);
    await auth.signIn(fake.origin);
    return { store, auth, grant: (store.credentials as { grant: OAuthGrant }).grant };
  }

  it("stores the rotated refresh token before the new access token is used", async () => {
    const { grant } = await signedIn();
    const order: string[] = [];
    let stored: OAuthGrant | undefined;
    const provider = new OAuthAuthProvider({ ...grant, expiresAt: Date.now() + 10_000 }, new OAuthClient(), {
      persist: (g) => {
        order.push("persist");
        stored = g;
      },
    });
    const token = await provider.accessToken();
    order.push("use");
    expect(order).toEqual(["persist", "use"]);
    expect(stored?.accessToken).toBe(token);
    expect(stored?.refreshToken).not.toBe(grant.refreshToken);
    const body = new URLSearchParams(fake.requests.filter((r) => r.path === "/gw/token").at(-1)!.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("resource")).toBe(fake.origin);
    expect(body.has("scope")).toBe(false);
  });

  it("shares one refresh between concurrent callers (rotation would end the grant otherwise)", async () => {
    const { grant } = await signedIn();
    const provider = new OAuthAuthProvider(grant, new OAuthClient(), { persist: () => {} });
    const [a, b] = await Promise.all([provider.tokenRejected(grant.accessToken), provider.tokenRejected(grant.accessToken)]);
    expect(a).toBe(b);
    expect(fake.requests.filter((r) => r.path === "/gw/token")).toHaveLength(2); // exchange + one refresh
  });

  it("invalid_grant means signed out and clears the grant", async () => {
    const { grant } = await signedIn();
    let cleared = false;
    const provider = new OAuthAuthProvider(grant, new OAuthClient(), { persist: (g) => void (cleared = g === undefined) });
    fake.tokenErrors.push({ status: 400, error: "invalid_grant" });
    await expect(provider.tokenRejected(grant.accessToken)).rejects.toMatchObject({ kind: "signedOut" });
    expect(cleared).toBe(true);
  });

  it("an ended session reads as expired, keeping the app and method for Sign in again", async () => {
    const { auth } = await signedIn();
    fake.tokenErrors.push({ status: 400, error: "invalid_grant" });
    expect(await auth.freshAccessToken()).toBeUndefined();
    expect(auth.state).toMatchObject({ status: "signedOut", expired: true, method: "oauth", appUrl: fake.origin });
    expect(auth.state.error).toMatch(/expired/);
  });

  it("signing out on purpose isn't expired", async () => {
    const { auth } = await signedIn();
    await auth.signOut();
    expect(auth.state.expired).toBeUndefined();
    expect(auth.state.method).toBeUndefined();
  });

  it("invalid_client on refresh forgets the client", async () => {
    const { grant } = await signedIn();
    const forgot: string[] = [];
    const provider = new OAuthAuthProvider(grant, new OAuthClient(), { persist: () => {}, forgetClient: (i) => forgot.push(i) });
    fake.tokenErrors.push({ status: 401, error: "invalid_client" });
    await expect(provider.tokenRejected(grant.accessToken)).rejects.toMatchObject({ kind: "signedOut" });
    expect(forgot).toEqual([fake.issuer]);
  });

  it("keeps the old refresh token when the server doesn't rotate", async () => {
    const client = new OAuthClient((async () =>
      new Response(JSON.stringify({ access_token: "new", token_type: "bearer", expires_in: 60 }), { status: 200 })) as typeof fetch);
    const grant: OAuthGrant = { appUrl: "https://a", issuer: "https://g", tokenEndpoint: "https://g/t", clientId: "c", resource: "https://a", accessToken: "old", refreshToken: "rt" };
    const renewed = await client.refresh(grant, 1000);
    expect(renewed).toMatchObject({ accessToken: "new", refreshToken: "rt", expiresAt: 61_000 });
  });

  it("refuses a non-bearer token type", async () => {
    const client = new OAuthClient((async () => new Response(JSON.stringify({ access_token: "x", token_type: "mac" }), { status: 200 })) as typeof fetch);
    const grant: OAuthGrant = { appUrl: "https://a", issuer: "https://g", tokenEndpoint: "https://g/t", clientId: "c", resource: "https://a", accessToken: "old", refreshToken: "rt" };
    await expect(client.refresh(grant)).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("sign-in endpoints must be https", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("refuses a Gateway whose metadata names a non-https endpoint", async () => {
    for (const bad of ["file:///etc/passwd", "x-apple.systempreferences:foo", "http://evil.example/authorize"]) {
      const client = new OAuthClient((async () =>
        json({ issuer: "https://g.example", authorization_endpoint: bad, token_endpoint: "https://g.example/token" })) as typeof fetch);
      await expect(client.discover("https://g.example")).rejects.toMatchObject({ kind: "discoveryFailed" });
    }
    const cleartext = new OAuthClient((async () =>
      json({ issuer: "https://g.example", authorization_endpoint: "https://g.example/a", token_endpoint: "http://g.example/token" })) as typeof fetch);
    await expect(cleartext.discover("https://g.example")).rejects.toMatchObject({ kind: "discoveryFailed" });
  });

  it("refuses an app that names a non-https Gateway", async () => {
    const client = new OAuthClient((async () => json({ resource: "https://a.example", authorization_servers: ["javascript:alert(1)"] })) as typeof fetch);
    await expect(client.discoverResource("https://a.example")).rejects.toMatchObject({ kind: "discoveryFailed" });
  });

  it("won't refresh or revoke against a stored non-https endpoint", async () => {
    let called = false;
    const client = new OAuthClient((async () => ((called = true), json({}))) as typeof fetch);
    const grant: OAuthGrant = { appUrl: "https://a", issuer: "https://g", tokenEndpoint: "http://g/t", revocationEndpoint: "file:///x", clientId: "c", resource: "https://a", accessToken: "old", refreshToken: "rt" };
    await expect(client.refresh(grant)).rejects.toBeInstanceOf(OAuthError);
    await client.revoke(grant);
    expect(called).toBe(false);
  });

  it("allows plain http only on local hosts", () => {
    expect(isSignInEndpoint("https://g.example/a")).toBe(true);
    expect(isSignInEndpoint("http://127.0.0.1:8787/a")).toBe(true);
    expect(isSignInEndpoint("http://everyapp.localhost/a")).toBe(true);
    expect(isSignInEndpoint("http://g.example/a")).toBe(false);
    expect(isSignInEndpoint("file:///etc/passwd")).toBe(false);
    expect(isSignInEndpoint(undefined)).toBe(false);
  });
});

describe("secret store", () => {
  it("reports a sign-in it can't decrypt and reads as signed out", async () => {
    const { store, path } = tempStore();
    store.setCredentials({ kind: "token", appUrl: "https://a", token: "epat_x" });
    const broken = new SecretStore(path, { ...fakeCipher, decrypt: () => { throw new Error("keychain"); } });
    const auth = new AuthService({ store: broken, openBrowser: () => {} });
    auth.restore();
    expect(auth.state.status).toBe("signedOut");
    expect(auth.state.error).toMatch(/can't read the saved sign-in/);
  });
  it("won't write without encryption", () => {
    const { store } = tempStore({ ...fakeCipher, isAvailable: () => false });
    expect(() => store.setCredentials({ kind: "token", appUrl: "https://a", token: "t" })).toThrow(/Keychain/);
  });
});
