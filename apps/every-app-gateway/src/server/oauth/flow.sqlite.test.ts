/**
 * The Gateway-owned OAuth flow end to end against a migrated SQLite
 * database and a fake provider (docs/design/2026-11-oauth-simplify.md): a
 * GitHub preset added with a client pasted in the UI, a person connecting
 * in an app, the connection stored sealed as theirs in that app, an app's
 * call through the proxy with the held token, the refresh, the expiry, the
 * disconnect with a revoke; the state rules and the return rule; and the
 * Google catalog entry with its client from D1. The generic spec, the mint
 * check and background use are in spec-flow.sqlite.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  mintIdentityJwt,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
  CAPABILITIES,
} from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import { apps, events, providerConnections, userAppAccess } from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
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
import { DEFAULT_RETURN, safeReturnTo, serveConnectRoute } from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import {
  addOAuthProvider,
  disconnect,
  listConnections,
  listOAuthProviders,
  listProviders,
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
  const rows: Record<string, string> = {};
  let github: ReturnType<typeof fakeOAuthProvider>;
  let now: number;

  afterEach(() => {
    vi.useRealTimers();
  });

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
    // The held-token path reads the real clock (`accessTokenFor` defaults
    // `now`), so pin Date to the test clock or every token minted here
    // looks expired once the wall clock passes it.
    vi.useFakeTimers({ toFake: ["Date"], now });
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
            scopes: ["repo"],
            why: "Lists the repositories a deal is about.",
          },
        },
      ],
      [
        "ci",
        {
          "github-oauth": {
            scopes: ["repo", "workflow"],
            why: "Opens issues for failed builds.",
          },
        },
      ],
      [
        "seo",
        {
          "google-workspace": {
            scopes: ["webmasters.readonly"],
            why: "Reads Search Console.",
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
      rows[appSlug] = plan.app.id;
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

  /** Connect the signed-in person at `provider`, through the whole flow; the final redirect. */
  async function connect(
    provider: string,
    query = "?app=crm",
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
      bound: true,
      client: {
        source: "d1",
        clientId: "gh-client-id",
        addedBy: "ben@acme.test",
      },
      redirectUri: `${GATEWAY}/connect/github-oauth/callback`,
      connections: 0,
    });
    expect(JSON.stringify(added)).not.toContain("gh-client-secret");
    const listed = await listOAuthProviders(org("owner", owner));
    expect(listed.map((each) => each.id)).toContain("github-oauth");
    expect(listed.map((each) => each.id)).toContain("google-workspace");
    expect(await eventTypes()).toEqual(["provider.added", "provider.updated"]);
    await expect(
      addOAuthProvider(org("member", member), null, { preset: "github-oauth" }),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
  });

  it("lists whether each provider's credential is set and which apps it keeps closed, never a value", async () => {
    const byId = async () => {
      resetAppSetupCacheForTests();
      const listed = await listProviders(org("owner", owner));
      return new Map(listed.map((each) => [each.id, each]));
    };
    let providers = await byId();
    expect(providers.get("dataforseo")).toMatchObject({
      kind: "api_key",
      configured: false,
      apps: [{ name: "notes", needs: true }],
    });
    expect(providers.get("google-workspace")).toMatchObject({
      configured: false,
      apps: [{ name: "seo", needs: true }],
    });

    const settings = fakeEnv as Record<string, string>;
    settings["DATAFORSEO_API_KEY"] = "login:dfs-secret-value";
    try {
      providers = await byId();
      expect(providers.get("dataforseo")).toMatchObject({
        configured: true,
        apps: [{ name: "notes", needs: false }],
      });
      // An OAuth provider counts once a client is live from either source.
      await addGitHub();
      providers = await byId();
      expect(providers.get("github-oauth")).toMatchObject({
        kind: "oauth",
        source: "row",
        configured: true,
      });
      expect(
        providers
          .get("github-oauth")
          ?.apps.map((app) => app.name)
          .sort(),
      ).toEqual(["ci", "crm"]);
      const text = JSON.stringify([...providers.values()]);
      expect(text).not.toContain("dfs-secret-value");
      expect(text).not.toContain("gh-client-secret");
    } finally {
      delete settings["DATAFORSEO_API_KEY"];
    }
  });

  it("connects a person in an app: PKCE S256, a one-use state, exactly the app's scopes, the tokens sealed, the return to the app", async () => {
    await addGitHub();
    const started = await browse(
      "/connect/github-oauth?app=crm&return=https://crm.apps.example.com/settings",
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
      // crm's scopes alone: not ci's `workflow`.
      scope: "repo",
    });
    // `oauth.pkce-on-connect`: a challenge, never the verifier.
    expect(params["code_challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params["state"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params["include_granted_scopes"]).toBeUndefined();

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
      userId: owner,
      appRowId: rows["crm"],
      label: "ben",
      externalId: "4242",
      status: "active",
    });
    expect(JSON.parse(row!.scopes)).toEqual(["repo"]);
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
        userId: owner,
        userEmail: "ben@acme.test",
        app: { rowId: rows["crm"], id: "crm", name: "crm" },
        label: "ben",
        scopes: ["repo"],
        status: "active",
      },
    ]);
    expect(JSON.stringify(mine)).not.toContain(issued.accessToken);
  });

  it("starts a connect only from an app that lists the provider and that the person opens", async () => {
    await addGitHub();
    const none = await browse("/connect/github-oauth");
    expect(none?.status).toBe(400);
    expect(await none?.text()).toContain("inside the app");
    const unknown = await browse("/connect/github-oauth?app=nope");
    expect(unknown?.status).toBe(404);
    const unlisted = await browse("/connect/github-oauth?app=notes");
    expect(unlisted?.status).toBe(400);
    expect(await unlisted?.text()).toContain("list GitHub in its");
    // Pat doesn't open crm: no connect for it.
    signIn(member, "pat@acme.test");
    const closed = await browse("/connect/github-oauth?app=crm");
    expect(closed?.status).toBe(404);
    await db.insert(userAppAccess).values({
      id: "grant-pat-crm",
      organizationId: acme,
      userId: member,
      appRowId: rows["crm"]!,
    });
    const open = await browse("/connect/github-oauth?app=crm");
    expect(open?.status).toBe(302);
    expect(github.state.counters.token).toBe(0);
  });

  it("refuses a callback for another person's state, an expired one, and a provider error, each on a page", async () => {
    await addGitHub();
    const started = await browse("/connect/github-oauth?app=crm");
    const back = github.authorize(started!.headers.get("location")!);
    signIn(member, "pat@acme.test");
    const foreign = await browse(back.pathname + back.search);
    expect(foreign?.status).toBe(400);
    expect(await foreign?.text()).toContain("started by someone else");
    expect(github.state.counters.token).toBe(0);

    signIn(owner, "ben@acme.test");
    const second = await browse("/connect/github-oauth?app=crm");
    const late = github.authorize(second!.headers.get("location")!);
    now += 11 * 60 * 1000;
    const expired = await browse(late.pathname + late.search);
    expect(expired?.status).toBe(400);
    expect(github.state.counters.token).toBe(0);

    const third = await browse("/connect/github-oauth?app=crm");
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
      "?app=crm&return=https://evil.example/steal",
    );
    expect(finished.status).toBe(302);
    expect(finished.headers.get("location")).toBe(DEFAULT_RETURN);
  });

  it("completes an app's API call with the held token, refreshes when due, reports the connection in the status, and never hands the token to the app (`oauth.held-token-never-to-app`)", async () => {
    await addGitHub();
    await connect("github-oauth");
    const issued = { ...github.state.tokens[0]! };

    const status = await appCall("crm", "/api/integrations/github-oauth");
    expect(status.status).toBe(200);
    const statusBody = await status.text();
    expect(JSON.parse(statusBody)).toEqual({
      capability: "github-oauth",
      requested: true,
      configured: true,
      ready: true,
      scopes: ["repo"],
      connectPath: "/connect/github-oauth?app=crm",
      connection: { label: "ben", scopes: ["repo"], ready: true },
      settings: [],
      setup: null,
      command: null,
    });
    expect(statusBody).not.toContain(issued.accessToken);
    expect(statusBody).not.toContain("gh-client");

    const repos = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user/repos?per_page=5&access_token=app-token",
      {
        headers: {
          authorization: "Bearer app-token",
          cookie: "a=b",
          "x-http-method-override": "DELETE",
        },
      },
    );
    expect(repos.status).toBe(200);
    // The identity read at connect time was the first API call.
    const api = github.state.apiRequests.at(-1)!;
    expect(api.bearer).toBe(issued.accessToken);
    expect(api.url).toBe("https://api.github.com/user/repos?per_page=5");
    expect(api.headers["cookie"]).toBeUndefined();
    expect(api.headers["x-http-method-override"]).toBeUndefined();
    expect(api.headers["x-everyapp-identity"]).toBeUndefined();
    const connection = (await listConnections(org("owner", owner)))[0]!;
    expect(connection.lastUsedAt).not.toBeNull();

    // Any method: the scopes the person approved are the grant.
    const write = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues",
      { method: "POST" },
    );
    expect(write.status).toBe(200);
    expect(github.state.apiRequests.at(-1)!.method).toBe("POST");
    // ci has no connection of this person's: crm's is crm's alone.
    const ci = await appCall(
      "ci",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(ci.status).toBe(409);
    await expect(ci.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/github-oauth?app=ci",
      reconnect: false,
    });

    // Due for a refresh: the refreshed token is sealed and used.
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

    // Background work with no person and no member named has no connection.
    const background = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
      { user: null },
    );
    expect(background.status).toBe(409);
    await expect(background.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/github-oauth?app=crm",
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

  it("asks for a reconnect when the connection lacks a scope the app declares, naming it", async () => {
    await addGitHub();
    await connect("github-oauth", "?app=ci");
    const [row] = await db
      .select({ id: providerConnections.id })
      .from(providerConnections);
    // The person un-ticked `workflow` on the consent screen.
    await db
      .update(providerConnections)
      .set({ scopes: JSON.stringify(["repo"]) })
      .where(eq(providerConnections.id, row!.id));
    const refused = await appCall(
      "ci",
      "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues",
      { method: "POST" },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/github-oauth?app=ci",
      reconnect: true,
      missingScopes: ["workflow"],
    });
    const status = await appCall("ci", "/api/integrations/github-oauth");
    await expect(status.json()).resolves.toMatchObject({
      ready: false,
      connection: {
        scopes: ["repo"],
        ready: false,
        reconnect: true,
        missingScopes: ["workflow"],
      },
    });
  });

  it("disconnects: the row goes, GitHub's grant is revoked with the client, the event says so", async () => {
    await addGitHub();
    await connect("github-oauth");
    const issued = { ...github.state.tokens[0]! };
    const [mine] = await listConnections(org("owner", owner));
    await expect(
      disconnect(
        org("member", member),
        null,
        { connectionId: mine!.id },
        github.fetch,
      ),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "github-oauth", app: "crm" },
      github.fetch,
    );
    expect(result).toMatchObject({ removed: true, revoked: true });
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

  it("runs the Google catalog entry on a client pasted in the UI: offline access asked, the identity read, Google's hosts reached through the proxy", async () => {
    const googleFlow = CAPABILITIES["google-workspace"].flow;
    const google = fakeOAuthProvider({
      authorizeUrl: googleFlow.authorizeUrl,
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
      connectPath: "/connect/google-workspace?app=seo",
      connection: null,
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
        `${GATEWAY}/connect/google-workspace?app=seo&return=/admin/providers`,
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
    // seo's scope, joined onto Google's prefix, then the identity scopes.
    expect(params["scope"]).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly openid email",
    );
    expect(params["include_granted_scopes"]).toBeUndefined();
    const back = google.authorize(authorize);
    const finished = await serveConnectRoute(new Request(back), {
      fetchUpstream,
      now: () => now,
    });
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe("/admin/providers");
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      providerId: "google-workspace",
      app: { id: "seo" },
      label: "ben@gmail.test",
      scopes: ["webmasters.readonly", "openid", "email"],
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
    // A host outside Google's never gets the token.
    const outside = await appCall(
      "seo",
      "/api/integrations/google-workspace/evil.example/steal",
      { fetchUpstream },
    );
    expect(outside.status).toBe(400);
    expect(outside.headers.get("x-everyapp-error")).toBe(
      "invalid_integration_route",
    );
    expect(google.state.counters.api).toBe(1);
    // Google is never revoked at Google on disconnect: its spec has no revoke URL.
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "google-workspace" },
      fetchUpstream,
    );
    expect(result).toMatchObject({ removed: true, revoked: false });
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
        ...githubCapability.flow,
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
