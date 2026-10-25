/**
 * The Gateway-owned OAuth flow end to end against a migrated SQLite
 * database and a fake provider (docs/design/2026-10-oauth-providers.md
 * sections 5 to 7): a GitHub preset added with a client pasted in the UI,
 * a person connecting from an app, the connection stored sealed, an app's
 * call through the proxy with the held token, the refresh, the expiry, the
 * disconnect with a revoke; the state rules, the return rule, the scope
 * rules; and the Google catalog entry with its client from D1.
 */
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
const fakeEnv = vi.hoisted(() => ({
  GATEWAY_URL: "https://home.example.com",
  APP_BASE_DOMAIN: "apps.example.com",
  GATEWAY_DEPLOYMENT_MODE: "self_hosted",
  BETTER_AUTH_SECRET: "a-secret-long-enough-for-sealing-0123456789",
  JWT_PUBLIC_KEY: "",
}));
const session = vi.hoisted(() => ({
  current: null as {
    user: { id: string; email: string; banned?: boolean };
    session: { activeOrganizationId: string | null };
  } | null,
}));

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});
vi.mock("cloudflare:workers", () => ({
  env: fakeEnv,
  waitUntil: () => undefined,
  WorkerEntrypoint: class {},
}));
vi.mock("@/auth", () => ({
  auth: { api: { getSession: async () => session.current } },
}));

import {
  isOAuthProvider,
  mintIdentityJwt,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  CAPABILITIES,
} from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import { events, providerConnections } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import {
  gatewayProviders,
  resetGatewayProvidersForTests,
} from "@/server/providers";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { isSealed } from "@/server/secrets/sealed";
import { fakeOAuthProvider } from "@/test/fake-oauth-provider";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { resolveOAuthClient } from "./client";
import {
  DEFAULT_RETURN,
  grantedSets,
  safeReturnTo,
  serveConnectRoute,
} from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import {
  addOAuthProvider,
  disconnect,
  listConnections,
  listOAuthProviders,
  setOAuthClient,
} from "./service";

const GATEWAY = "https://home.example.com";
const GITHUB = OAUTH_PRESETS["github-oauth"]! as {
  auth: { authorizeUrl: string; tokenUrl: string };
};
const githubCapability = (() => {
  const parsed = parseProviderSpec(GITHUB);
  if (!parsed.ok || parsed.capability.mode !== "oauth_client")
    throw new Error("preset");
  return parsed.capability;
})();

let privateKeyPem: string;

beforeAll(() => {
  const keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKeyPem = keys.privateKey;
  fakeEnv.JWT_PUBLIC_KEY = keys.publicKey;
});

describe("the Gateway-owned OAuth flow (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  const workers: Record<string, string> = {};
  let github: ReturnType<typeof fakeOAuthProvider>;
  let now: number;

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    clearAppCallerCacheForTests();
    clearOrgContextCacheForTests();
    resetGatewayProvidersForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    now = Date.parse("2026-10-25T20:00:00Z");
    acme = await seedOrganization(db, "acme");
    owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
      email: "ben@acme.test",
    });
    member = await seedMember(db, {
      organizationId: acme,
      role: "member",
      email: "pat@acme.test",
    });
    for (const [appSlug, capabilities] of [
      [
        "crm",
        {
          "github-oauth": {
            access: "read",
            scopes: ["identity", "repo.read"],
            why: "Lists the repositories a deal is about.",
          },
        },
      ],
      [
        "ci",
        {
          "github-oauth": { access: "write", scopes: ["repo.write"] },
        },
      ],
      [
        "seo",
        {
          "google-workspace": {
            access: "read",
            scopes: ["identity", "search-console.read"],
          },
        },
      ],
      ["notes", { dataforseo: { access: "read" } }],
    ] as const) {
      const plan = await deployLiveApp(db, {
        organizationId: acme,
        appSlug,
        manifest: { id: appSlug, capabilities },
        deployerUserId: owner,
      });
      workers[appSlug] = plan.app.workerName!;
    }
    github = fakeOAuthProvider({
      authorizeUrl: GITHUB.auth.authorizeUrl,
      tokenUrl: GITHUB.auth.tokenUrl,
      apiHost: "api.github.com",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      scopeDialect: "comma",
      revokeUrl: "https://api.github.com/applications/gh-client-id/grant",
      identity: { path: "/user", body: { login: "ben", id: 4242 } },
    });
    signIn(owner, "ben@acme.test");
    resetGatewayProvidersForTests();
  });

  function signIn(userId: string, email: string) {
    session.current = {
      user: { id: userId, email },
      session: { activeOrganizationId: acme },
    };
  }

  const org = (role: "owner" | "admin" | "member", userId: string) => ({
    orgId: acme,
    userId,
    role,
  });

  /** A browser's GET on the gateway host, as the signed-in person. */
  function browse(path: string) {
    return serveConnectRoute(new Request(`${GATEWAY}${path}`), {
      fetchUpstream: github.fetch,
      now: () => now,
    });
  }

  /** Connect `userId` at `provider`, through the whole flow; the final redirect. */
  async function connect(
    provider: string,
    query = "",
    fetchUpstream: (request: Request) => Promise<Response> = github.fetch,
    authorize: (url: string) => URL = (url) => github.authorize(url),
  ): Promise<Response> {
    const started = await serveConnectRoute(
      new Request(`${GATEWAY}/connect/${provider}${query}`),
      { fetchUpstream, now: () => now },
    );
    expect(started?.status).toBe(302);
    const back = authorize(started!.headers.get("location")!);
    const finished = await serveConnectRoute(new Request(back), {
      fetchUpstream,
      now: () => now,
    });
    return finished!;
  }

  /** An app's call through the AppGateway entrypoint, as a person or as background work. */
  async function appCall(
    appSlug: string,
    path: string,
    options: {
      user?: string | null;
      method?: string;
      headers?: Record<string, string>;
      fetchUpstream?: (request: Request) => Promise<Response>;
    } = {},
  ): Promise<Response> {
    clearAppCallerCacheForTests();
    const headers = new Headers(options.headers);
    const userId = options.user === undefined ? owner : options.user;
    if (userId) {
      headers.set(
        "x-everyapp-identity",
        await mintIdentityJwt(privateKeyPem, {
          subject: {
            sub: userId,
            email: userId === owner ? "ben@acme.test" : "pat@acme.test",
            orgId: acme,
            orgRole: userId === owner ? "owner" : "member",
          },
          audience: workers[appSlug]!,
          issuer: GATEWAY,
          now,
        }),
      );
    }
    const fetchUpstream = options.fetchUpstream ?? github.fetch;
    return handleAppGatewayRequest({
      request: new Request(`http://every-app-gateway.internal${path}`, {
        method: options.method ?? "GET",
        headers,
      }),
      props: {
        organizationId: acme,
        appId: appSlug,
        workerName: workers[appSlug],
      },
      env: fakeEnv as never,
      registry: new DrizzleAppRegistry(db as never),
      organizations: OrganizationRepository,
      fetchUpstream,
      providers: gatewayProviders,
      oauth: async () => ({
        resolveClient: resolveOAuthClient,
        connections: gatewayHeldTokens({ fetchUpstream }),
      }),
    });
  }

  async function addGitHub() {
    const added = await addOAuthProvider(org("owner", owner), null, {
      preset: "github-oauth",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
    });
    resetGatewayProvidersForTests();
    return added;
  }

  async function eventTypes(): Promise<string[]> {
    const rows = await db.select({ type: events.type }).from(events);
    return rows.map((row) => row.type);
  }

  it("adds the GitHub preset as a row with its client sealed in D1, and shows the redirect URI", async () => {
    const added = await addGitHub();
    expect(added).toMatchObject({
      id: "github-oauth",
      name: "GitHub",
      source: "row",
      kind: "oauth",
      flow: "both",
      bound: true,
      client: {
        source: "d1",
        clientId: "gh-client-id",
        addedBy: "ben@acme.test",
      },
      redirectUri: `${GATEWAY}/connect/github-oauth/callback`,
      connections: 0,
    });
    expect(added.scopeSets.map((set) => set.name)).toEqual([
      "identity",
      "repo.read",
      "repo.write",
      "org.read",
    ]);
    expect(JSON.stringify(added)).not.toContain("gh-client-secret");
    const listed = await listOAuthProviders(org("owner", owner));
    expect(listed.map((each) => each.id)).toContain("github-oauth");
    expect(listed.map((each) => each.id)).toContain("google-workspace");
    expect(await eventTypes()).toEqual(["provider.added", "provider.updated"]);
    await expect(
      addOAuthProvider(org("member", member), null, { preset: "github-oauth" }),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("connects a person: PKCE S256, a one-use state, the sets the apps declare, the tokens sealed, the return to the app", async () => {
    await addGitHub();
    const started = await browse(
      "/connect/github-oauth?return=https://crm.apps.example.com/settings",
    );
    expect(started?.status).toBe(302);
    const authorize = new URL(started!.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      GITHUB.auth.authorizeUrl,
    );
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "gh-client-id",
      redirect_uri: `${GATEWAY}/connect/github-oauth/callback`,
      code_challenge_method: "S256",
    });
    // `oauth.pkce-on-connect`: a challenge, never the verifier.
    expect(params["code_challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params["state"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The union of what crm (identity, repo.read) and ci (repo.write)
    // declare, in the preset's order, comma-joined as GitHub spells scopes.
    expect(params["scope"]).toBe("read:user,user:email,repo");

    const back = github.authorize(authorize);
    const finished = await browse(back.pathname + back.search);
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe(
      "https://crm.apps.example.com/settings",
    );
    expect(github.state.tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      clientVia: "form",
      clientId: "gh-client-id",
      clientSecretPresent: true,
      redirectUri: `${GATEWAY}/connect/github-oauth/callback`,
    });
    expect(github.state.tokenRequests[0]!.codeVerifier).toBeTruthy();
    expect(github.state.tokenRequests[0]!.headers["accept"]).toBe(
      "application/json",
    );

    // `oauth.tokens-sealed-at-rest`: the row holds ciphertext only.
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.providerId, "github-oauth"));
    const issued = { ...github.state.tokens[0]! };
    expect(row).toMatchObject({
      organizationId: acme,
      accountKind: "user",
      subject: owner,
      userId: owner,
      label: "ben",
      externalId: "4242",
      status: "active",
    });
    expect(JSON.parse(row!.scopeSets)).toEqual([
      "identity",
      "repo.read",
      "repo.write",
    ]);
    expect(isSealed(row!.accessTokenEnc)).toBe(true);
    expect(row!.accessTokenEnc).not.toContain(issued.accessToken);
    expect(row!.refreshTokenEnc).not.toContain(issued.refreshToken!);
    const tokens = await ProviderConnectionRepository.readTokens(
      row!.id,
      fakeEnv,
    );
    expect(tokens?.accessToken).toBe(issued.accessToken);

    // `oauth.state-single-use`: the same callback again is refused.
    const again = await browse(back.pathname + back.search);
    expect(again?.status).toBe(400);
    expect(await again?.text()).toContain("used already");
    expect(github.state.counters.token).toBe(1);

    expect(await eventTypes()).toContain("provider.connected");
    const mine = await listConnections(org("owner", owner));
    expect(mine).toMatchObject([
      {
        providerId: "github-oauth",
        providerName: "GitHub",
        account: "user",
        userId: owner,
        userEmail: "ben@acme.test",
        label: "ben",
        scopeSets: ["identity", "repo.read", "repo.write"],
        status: "active",
      },
    ]);
    expect(JSON.stringify(mine)).not.toContain(issued.accessToken);
  });

  it("refuses a callback for another person's state, an expired one, and a provider error, each on a page", async () => {
    await addGitHub();
    const started = await browse("/connect/github-oauth");
    const back = github.authorize(started!.headers.get("location")!);
    signIn(member, "pat@acme.test");
    const foreign = await browse(back.pathname + back.search);
    expect(foreign?.status).toBe(400);
    expect(await foreign?.text()).toContain("started by someone else");
    expect(github.state.counters.token).toBe(0);

    signIn(owner, "ben@acme.test");
    const second = await browse("/connect/github-oauth");
    const late = github.authorize(second!.headers.get("location")!);
    now += 11 * 60 * 1000;
    const expired = await browse(late.pathname + late.search);
    expect(expired?.status).toBe(400);
    expect(github.state.counters.token).toBe(0);

    const third = await browse("/connect/github-oauth");
    const state = new URL(third!.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const declined = await browse(
      `/connect/github-oauth/callback?error=access_denied&state=${state}`,
    );
    expect(declined?.status).toBe(400);
    expect(declined?.headers.get("location")).toBeNull();
    expect(await declined?.text()).toContain("declined");
    // The state was spent by the error: a code with it now is refused.
    const reused = await browse(
      `/connect/github-oauth/callback?code=x&state=${state}`,
    );
    expect(reused?.status).toBe(400);
    expect(github.state.counters.token).toBe(0);
    expect(await eventTypes()).not.toContain("provider.connected");
  });

  it("sends the browser only to the gateway's own hosts afterwards (`oauth.return-to-own-hosts`)", async () => {
    expect(safeReturnTo("https://evil.example/steal")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("//evil.example/steal")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("http://crm.apps.example.com/x")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("javascript:alert(1)")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("http://localhost:3000/x")).toBe(DEFAULT_RETURN);
    expect(safeReturnTo("/admin/providers")).toBe("/admin/providers");
    expect(safeReturnTo("https://crm.apps.example.com/x?y=1")).toBe(
      "https://crm.apps.example.com/x?y=1",
    );
    expect(safeReturnTo("https://home.example.com/settings")).toBe(
      "https://home.example.com/settings",
    );
    await addGitHub();
    const finished = await connect(
      "github-oauth",
      "?return=https://evil.example/steal",
    );
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe(DEFAULT_RETURN);
  });

  it("refuses a token answer carrying scopes beyond the sets asked, and keeps the sets granted whole", () => {
    const policy = githubCapability.scopePolicy!;
    expect(
      grantedSets(policy, { scope: "read:user,user:email,repo" }, [
        "identity",
        "repo.read",
      ]),
    ).toEqual({
      sets: ["identity", "repo.read"],
      scopes: ["read:user", "user:email", "repo"],
    });
    // A person who un-ticked `repo` keeps identity only.
    expect(
      grantedSets(policy, { scope: "read:user,user:email" }, [
        "identity",
        "repo.read",
      ]),
    ).toEqual({ sets: ["identity"], scopes: ["read:user", "user:email"] });
    expect(
      grantedSets(policy, { scope: "read:user,user:email,repo,delete_repo" }, [
        "identity",
        "repo.read",
      ]),
    ).toEqual({ refused: "excess", excess: ["delete_repo"] });
    // No `scope` in the answer: granted as requested (RFC 6749 §5.1).
    expect(grantedSets(policy, { access_token: "t" }, ["identity"])).toEqual({
      sets: ["identity"],
      scopes: ["read:user", "user:email"],
    });
    const google = CAPABILITIES["google-workspace"].scopePolicy!;
    expect(grantedSets(google, { access_token: "t" }, ["identity"])).toEqual({
      refused: "unverified",
    });
  });

  it("completes an app's API call with the held token, refreshes when due, reports the connection in the status, and never hands the token to the app (`oauth.held-token-never-to-app`)", async () => {
    await addGitHub();
    await connect("github-oauth");
    const issued = { ...github.state.tokens[0]! };

    const status = await appCall("crm", "/api/integrations/github-oauth");
    expect(status.status).toBe(200);
    const statusBody = await status.text();
    expect(JSON.parse(statusBody)).toMatchObject({
      capability: "github-oauth",
      requested: true,
      configured: true,
      ready: true,
      flow: "both",
      connectPath: "/connect/github-oauth",
      scopeSets: ["identity", "repo.read"],
      connection: {
        account: "user",
        label: "ben",
        scopeSets: ["identity", "repo.read", "repo.write"],
        ready: true,
      },
    });
    expect(statusBody).not.toContain(issued.accessToken);
    expect(statusBody).not.toContain("gh-client-secret");

    const repos = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user/repos?per_page=5&access_token=app-token",
      { headers: { authorization: "Bearer app-token", cookie: "a=b" } },
    );
    expect(repos.status).toBe(200);
    // The identity read at connect time was the first API call.
    const api = github.state.apiRequests.at(-1)!;
    expect(api.bearer).toBe(issued.accessToken);
    expect(api.url).toBe("https://api.github.com/user/repos?per_page=5");
    expect(api.headers["cookie"]).toBeUndefined();
    expect(api.headers["x-everyapp-identity"]).toBeUndefined();
    expect(api.headers["x-everyapp-account"]).toBeUndefined();
    const connection = (await listConnections(org("owner", owner)))[0]!;
    expect(connection.lastUsedAt).not.toBeNull();

    // A write on a read grant is refused before any token is read.
    const write = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user/repos",
      { method: "POST" },
    );
    expect(write.status).toBe(405);
    expect(write.headers.get("x-everyapp-error")).toBe(
      "integration_method_not_allowed",
    );
    // ci declares repo.write, which this connection has: its write goes through.
    const ciWrite = await appCall(
      "ci",
      "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues",
      { method: "POST" },
    );
    expect(ciWrite.status).toBe(200);
    expect(github.state.apiRequests.at(-1)!.method).toBe("POST");

    // Due for a refresh: the token the provider rotates is sealed and used.
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: Date.now() + 10_000,
      },
      fakeEnv,
    );
    const refreshed = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(refreshed.status).toBe(200);
    expect(github.state.counters.refresh).toBe(1);
    const fresh = github.state.tokens.at(-1)!;
    expect(fresh.accessToken).not.toBe(issued.accessToken);
    expect(github.state.apiRequests.at(-1)!.bearer).toBe(fresh.accessToken);
    const stored = await ProviderConnectionRepository.readTokens(
      connection.id,
      fakeEnv,
    );
    expect(stored?.accessToken).toBe(fresh.accessToken);

    // Background work has no person: it needs the organization's account.
    const background = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
      { user: null, headers: { "x-everyapp-org": acme } },
    );
    expect(background.status).toBe(409);
    await expect(background.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/github-oauth",
      reconnect: false,
    });
    // A refusal never quotes a token.
    expect(
      JSON.stringify(
        await (
          await appCall(
            "notes",
            "/api/integrations/github-oauth/api.github.com/user",
          )
        ).json(),
      ),
    ).not.toContain(issued.accessToken);
  });

  it("marks a connection expired when the provider refuses the refresh, once, and asks for a reconnect", async () => {
    await addGitHub();
    await connect("github-oauth");
    const connection = (await listConnections(org("owner", owner)))[0]!;
    const issued = { ...github.state.tokens[0]! };
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: Date.now() - 1,
      },
      fakeEnv,
    );
    github.state.failNextToken = "invalid_grant";
    const apiCallsBefore = github.state.counters.api;
    const refused = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      reconnect: true,
    });
    expect(github.state.counters.api).toBe(apiCallsBefore);
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      status: "expired",
    });
    expect(await eventTypes()).toContain("provider.connection_expired");
    const again = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(again.status).toBe(409);
    expect(github.state.counters.token).toBe(2);
    const status = await appCall("crm", "/api/integrations/github-oauth");
    await expect(status.json()).resolves.toMatchObject({
      ready: false,
      connection: { ready: false, reconnect: true },
    });
    // Connecting again replaces the row and clears the expiry.
    await connect("github-oauth");
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      status: "active",
    });
  });

  it("refuses an app whose declared sets the connection lacks, with the missing ones", async () => {
    await addGitHub();
    // Ask for identity only: the ci app's repo.write is not granted.
    await connect("github-oauth", "?sets=identity");
    const refused = await appCall(
      "ci",
      "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues",
      { method: "POST" },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      reconnect: true,
      missingSets: ["repo.write"],
    });
    const status = await appCall("ci", "/api/integrations/github-oauth");
    await expect(status.json()).resolves.toMatchObject({
      ready: false,
      connection: { scopeSets: ["identity"], ready: false, reconnect: true },
    });
    const bad = await browse("/connect/github-oauth?sets=nope");
    expect(bad?.status).toBe(400);
  });

  it("disconnects: the row goes, GitHub's grant is revoked with the client, the event says so", async () => {
    await addGitHub();
    await connect("github-oauth");
    const issued = { ...github.state.tokens[0]! };
    await expect(
      disconnect(
        org("member", member),
        null,
        {
          providerId: "github-oauth",
          account: "user",
          userId: owner,
        },
        github.fetch,
      ),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "github-oauth", account: "user" },
      github.fetch,
    );
    expect(result).toEqual({ removed: true, revoked: true });
    expect(github.state.revokeRequests).toEqual([
      { token: issued.accessToken, clientVia: "basic" },
    ]);
    expect(github.accepts(issued.accessToken)).toBe(false);
    expect(await listConnections(org("owner", owner))).toEqual([]);
    expect(await eventTypes()).toContain("provider.disconnected");
    const after = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(after.status).toBe(409);
  });

  it("connects the organization's account for an owner, which background work then uses", async () => {
    await addGitHub();
    signIn(member, "pat@acme.test");
    const refused = await browse("/connect/github-oauth?account=organization");
    expect(refused?.status).toBe(403);
    signIn(owner, "ben@acme.test");
    const finished = await connect("github-oauth", "?account=organization");
    expect(finished.status).toBe(302);
    const background = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
      { user: null, headers: { "x-everyapp-org": acme } },
    );
    expect(background.status).toBe(200);
    expect(github.state.apiRequests[0]!.bearer).toBe(
      github.state.tokens[0]!.accessToken,
    );
    // A person may pick the organization's account explicitly.
    const asOrg = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
      { headers: { "x-everyapp-account": "organization" } },
    );
    expect(asOrg.status).toBe(200);
    // Their own account is not connected.
    const own = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(own.status).toBe(409);
    expect(
      (await listConnections(org("owner", owner), { user: "all" })).map(
        (c) => c.account,
      ),
    ).toEqual(["organization"]);
  });

  it("runs the Google catalog entry on a client pasted in the UI: offline access asked, the identity read, Search Console reached through the proxy", async () => {
    const googleFlow = CAPABILITIES["google-workspace"].flow!;
    const google = fakeOAuthProvider({
      authorizeUrl: CAPABILITIES["google-workspace"].authorize.url,
      tokenUrl: googleFlow.tokenUrl,
      apiHost: "www.googleapis.com",
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      scopeDialect: "space",
    });
    const fetchUpstream = async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.hostname === "openidconnect.googleapis.com") {
        return Response.json({ email: "ben@gmail.test", sub: "g-1" });
      }
      return google.fetch(request);
    };
    // No env client: the entry is not configured until the UI gets one.
    const before = await appCall("seo", "/api/integrations/google-workspace", {
      fetchUpstream,
    });
    await expect(before.json()).resolves.toMatchObject({
      configured: false,
      ready: false,
    });
    const set = await setOAuthClient(
      org("admin", owner),
      null,
      "google-workspace",
      {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
    );
    expect(set).toMatchObject({
      id: "google-workspace",
      source: "catalog",
      client: { source: "d1", clientId: "google-client-id" },
      bound: true,
      redirectUri: `${GATEWAY}/connect/google-workspace/callback`,
    });
    resetGatewayProvidersForTests();

    const started = await serveConnectRoute(
      new Request(
        `${GATEWAY}/connect/google-workspace?return=/admin/providers`,
      ),
      { fetchUpstream, now: () => now },
    );
    const authorize = new URL(started!.headers.get("location")!);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      client_id: "google-client-id",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    // seo declares identity and search-console.read: those scopes, no more.
    expect(params["scope"]!.split(" ")).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/webmasters.readonly",
      ]),
    );
    expect(params["scope"]).not.toContain("analytics");
    const back = google.authorize(authorize);
    const finished = await serveConnectRoute(new Request(back), {
      fetchUpstream,
      now: () => now,
    });
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe("/admin/providers");
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      providerId: "google-workspace",
      label: "ben@gmail.test",
      scopeSets: ["identity", "search-console.read"],
    });

    const sites = await appCall(
      "seo",
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites",
      { fetchUpstream },
    );
    expect(sites.status).toBe(200);
    expect(google.state.apiRequests[0]!.bearer).toBe(
      google.state.tokens[0]!.accessToken,
    );
    // Analytics is not a set seo declares: its read is outside the sets,
    // and its read-shaped POST is a write on seo's read grant.
    const analytics = await appCall(
      "seo",
      "/api/integrations/google-workspace/analyticsadmin.googleapis.com/v1beta/accountSummaries",
      { fetchUpstream },
    );
    expect(analytics.status).toBe(403);
    expect(analytics.headers.get("x-everyapp-error")).toBe(
      "integration_scope_not_allowed",
    );
    const report = await appCall(
      "seo",
      "/api/integrations/google-workspace/analyticsdata.googleapis.com/v1beta/properties/1:runReport",
      { method: "POST", fetchUpstream },
    );
    expect(report.status).toBe(405);
    expect(google.state.counters.api).toBe(1);
    // The app-driven token endpoint still answers for an app with the write grant, on the same client.
    expect(isOAuthProvider(CAPABILITIES["google-workspace"])).toBe(true);
    // Google is never revoked at Google on disconnect (section 5).
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "google-workspace", account: "user" },
      fetchUpstream,
    );
    expect(result).toEqual({ removed: true, revoked: false });
    expect(google.state.counters.revoke).toBe(0);
  });

  it("reads a D1 client only while it was uploaded for the provider as it is now (`oauth.client-bound-to-endpoints`)", async () => {
    await addGitHub();
    const resolved = await resolveOAuthClient({
      id: "github-oauth",
      capability: githubCapability,
      env: fakeEnv as never,
    });
    expect(resolved).toEqual({
      source: "d1",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
    });
    const moved = {
      ...githubCapability,
      flow: {
        ...githubCapability.flow!,
        tokenUrl: "https://evil.example/token",
      },
    };
    expect(providerBindingKey(moved)).not.toBe(
      providerBindingKey(githubCapability),
    );
    expect(
      await resolveOAuthClient({
        id: "github-oauth",
        capability: moved,
        env: fakeEnv as never,
      }),
    ).toBeNull();
    // The Worker env wins over D1.
    expect(
      await resolveOAuthClient({
        id: "github-oauth",
        capability: githubCapability,
        env: {
          ...fakeEnv,
          GITHUB_OAUTH_CLIENT_ID: "env-id",
          GITHUB_OAUTH_CLIENT_SECRET: "env-secret",
        } as never,
      }),
    ).toEqual({
      source: "env",
      clientId: "env-id",
      clientSecret: "env-secret",
    });
  });
});
