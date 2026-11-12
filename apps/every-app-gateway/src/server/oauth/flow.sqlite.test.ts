/**
 * The Gateway-owned OAuth flow end to end against a migrated SQLite
 * database and a fake provider
 * (docs/design/2026-11-oauth-one-connection.md): a GitHub preset added
 * with a client pasted in the UI, a person connecting from inside an app,
 * the connection stored sealed as theirs with that app allowed to use it,
 * an app's call through the proxy with the held token, the refresh, the
 * expiry, the connections list with each connection's apps, one app's
 * access taken away, the disconnect with a revoke; the state rules and the
 * return rule; the Google preset registered as a deploy registers it, with
 * its client from D1; and an MCP server's row: `resource` on every leg,
 * `iss` checked, scopes lenient for the app's own row only. The generic
 * spec, the Allow page's form, the mint check and background use are in
 * spec-flow.sqlite.test.ts.
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
  mcpOAuthProviderSpec,
  mintIdentityJwt,
  OAUTH_PRESETS,
  parseProviderSpec,
  providerBindingKey,
} from "@every-app/sdk/internal";
import { eq } from "drizzle-orm";
import {
  apps,
  events,
  providerAppAccess,
  providerConnections,
  userAppAccess,
} from "@/db/schema";
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
import { ReconnectOutcome } from "@/schemas/app-access";
import {
  DEFAULT_RETURN,
  safeReturnTo,
  serveConnectRoute,
  startReconnect,
} from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import { accessTokenFor } from "./tokens";
import {
  addOAuthProvider,
  disconnect,
  listConnections,
  listOAuthProviders,
  listProviders,
  planPresetProviders,
  removeAppAccess,
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

  /**
   * The signed-in person allows `app` to use the connection they have, on
   * the Gateway's own page: the connect leads there, and its form is posted.
   */
  async function allow(app: string, provider = "github-oauth") {
    const started = await browse(`/connect/${provider}?app=${app}`);
    expect(started?.status).toBe(302);
    const page = new URL(started!.headers.get("location")!, GATEWAY);
    expect(page.origin + page.pathname).toBe(`${GATEWAY}/oauth/app-access`);
    const answered = await serveConnectRoute(
      new Request(`${GATEWAY}/connect/${provider}/allow`, {
        method: "POST",
        body: new URLSearchParams({
          state: page.searchParams.get("state")!,
          decision: "approve",
        }),
      }),
      { fetchUpstream: github.fetch, now: () => now },
    );
    expect(answered?.status).toBe(303);
  }

  /** Every access row, as `user app`, sorted. */
  async function accessRows(): Promise<string[]> {
    const slugs = Object.fromEntries(
      Object.entries(rows).map(([slug, rowId]) => [rowId, slug]),
    );
    return (await db.select().from(providerAppAccess))
      .map((row) => `${row.userId} ${slugs[row.appRowId] ?? row.appRowId}`)
      .sort();
  }

  /** Pat opens crm by a person's grant. */
  async function grantPatCrm() {
    await db.insert(userAppAccess).values({
      id: "grant-pat-crm",
      organizationId: acme,
      userId: member,
      appRowId: rows["crm"]!,
    });
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
    // A preset is listed once its row is.
    expect(listed.map((each) => each.id)).not.toContain("google-workspace");
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
    await addOAuthProvider(org("owner", owner), null, {
      preset: "google-workspace",
    });
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

  it("connects a person from inside an app: PKCE S256, a one-use state, the scopes of every app that lists the provider, the tokens sealed, that app allowed, the return to the app", async () => {
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
      // crm's `repo` and ci's `workflow`, each once: one consent covers
      // every app that lists GitHub.
      scope: "repo,workflow",
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
      label: "ben",
      externalId: "4242",
      status: "active",
    });
    expect(JSON.parse(row!.scopes)).toEqual(["repo", "workflow"]);
    // The app the connect started in is allowed, for the scopes it lists;
    // ci is not, though the connection holds its scopes.
    const access = await db.select().from(providerAppAccess);
    expect(access).toMatchObject([
      {
        organizationId: acme,
        providerId: "github-oauth",
        userId: owner,
        appRowId: rows["crm"],
      },
    ]);
    expect(JSON.parse(access[0]!.scopes)).toEqual(["repo"]);
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
        apps: [{ rowId: rows["crm"], id: "crm", name: "crm" }],
        label: "ben",
        scopes: ["repo", "workflow"],
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
      connection: { label: "ben", scopes: ["repo", "workflow"], ready: true },
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
    // The connection holds ci's scopes, but Ben hasn't allowed ci to use it.
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

  it("refreshes once when parallel calls find the token due, so a provider that rotates refresh tokens keeps the connection", async () => {
    const rotating = fakeOAuthProvider({
      authorizeUrl: GITHUB.auth.authorizeUrl,
      tokenUrl: GITHUB.auth.tokenUrl,
      apiHost: "api.github.com",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      scopeDialect: "comma",
      rotateRefreshToken: true,
      identity: { path: "/user", body: { login: "ben", id: 4242 } },
    });
    await addGitHub();
    await connect("github-oauth", "?app=crm", rotating.fetch, (url) =>
      rotating.authorize(url),
    );
    const connection = (await listConnections(org("owner", owner)))[0]!;
    const issued = { ...rotating.state.tokens[0]! };
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: Date.now() - 1,
      },
      fakeEnv,
    );
    const calls = await Promise.all(
      [1, 2, 3, 4].map(() =>
        appCall("crm", "/api/integrations/github-oauth/api.github.com/user", {
          fetchUpstream: rotating.fetch,
        }),
      ),
    );
    expect(calls.map((call) => call.status)).toEqual([200, 200, 200, 200]);
    // One refresh spent the refresh token; the others used what it stored.
    expect(rotating.state.counters.refresh).toBe(1);
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      status: "active",
    });
    expect(await eventTypes()).not.toContain("provider.connection_expired");
  });

  it("keeps a connection when its refresh is refused because a parallel refresh already rotated the token", async () => {
    const rotating = fakeOAuthProvider({
      authorizeUrl: GITHUB.auth.authorizeUrl,
      tokenUrl: GITHUB.auth.tokenUrl,
      apiHost: "api.github.com",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      scopeDialect: "comma",
      rotateRefreshToken: true,
      identity: { path: "/user", body: { login: "ben", id: 4242 } },
    });
    await addGitHub();
    await connect("github-oauth", "?app=crm", rotating.fetch, (url) =>
      rotating.authorize(url),
    );
    const connection = (await listConnections(org("owner", owner)))[0]!;
    const issued = { ...rotating.state.tokens[0]! };
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: Date.now() - 1,
      },
      fakeEnv,
    );
    const registry = await gatewayProviders();
    const capability = registry.get("github-oauth");
    if (capability?.mode !== "oauth_client") throw new Error("oauth row");
    const client = await resolveOAuthClient({
      id: "github-oauth",
      capability,
      env: fakeEnv as never,
      lookup: registry,
    });
    // A slow first refresh: while it is at the provider, its lease lapses
    // and a second call refreshes with the same token and stores the
    // rotation; the provider then refuses the first as spent.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    const slowFirst = async (request: Request): Promise<Response> => {
      if (first && new URL(request.url).href === GITHUB.auth.tokenUrl) {
        first = false;
        await held;
      }
      return rotating.fetch(request);
    };
    const refresh = (at: number) =>
      accessTokenFor({
        connectionId: connection.id,
        scopes: connection.scopes,
        capability,
        client: client!,
        env: fakeEnv as never,
        fetchUpstream: slowFirst,
        now: at,
        log: { provider: "github-oauth" },
      });
    const slow = refresh(now);
    await vi.waitFor(() => expect(first).toBe(false));
    const second = await refresh(now + 31_000);
    expect(second.ok).toBe(true);
    release();
    await expect(slow).resolves.toEqual(second);
    expect(rotating.state.counters.refresh).toBe(2);
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      status: "active",
    });
  });

  it("refreshes a token the provider answers 401 for though it isn't due, and sends the request once more", async () => {
    await addGitHub();
    await connect("github-oauth");
    const connection = (await listConnections(org("owner", owner)))[0]!;
    const issued = { ...github.state.tokens[0]! };
    // No lifetime stored, and an access token GitHub no longer takes.
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: "gho_ended_early",
        refreshToken: issued.refreshToken,
        expiresAt: null,
      },
      fakeEnv,
    );
    const refreshesBefore = github.state.counters.refresh;
    const called = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(called.status).toBe(200);
    await expect(called.json()).resolves.toMatchObject({ login: "ben" });
    expect(github.state.counters.refresh).toBe(refreshesBefore + 1);
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      status: "active",
    });
  });

  it("reconnects a healthy connection with a fresh grant when asked, replacing it in place", async () => {
    await addGitHub();
    await connect("github-oauth");
    const key = {
      organizationId: acme,
      providerId: "github-oauth",
      userId: owner,
    };
    const before = (await listConnections(org("owner", owner)))[0]!;
    // Without `fresh`, nothing is missing, so no provider is asked.
    await expect(startReconnect(key)).resolves.toMatchObject({
      outcome: ReconnectOutcome.Allowed,
    });
    expect(github.state.counters.token).toBe(1);
    const fresh = await startReconnect(key, { fresh: true });
    expect(fresh.outcome).toBe(ReconnectOutcome.Provider);
    const url = (fresh as { url: string }).url;
    expect(new URL(url).origin + new URL(url).pathname).toBe(
      GITHUB.auth.authorizeUrl,
    );
    const back = await serveConnectRoute(new Request(github.authorize(url)), {
      fetchUpstream: github.fetch,
      now: () => now,
    });
    expect(back?.status).toBe(302);
    expect(back?.headers.get("location")).toBe(DEFAULT_RETURN);
    // A new token, on the same one row, and crm still allowed.
    expect(github.state.counters.token).toBe(2);
    const after = await listConnections(org("owner", owner));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before.id, status: "active" });
    expect(await db.select().from(providerConnections)).toHaveLength(1);
    expect(await accessRows()).toEqual([`${owner} crm`]);
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

  it("lists each connection once, with the apps its person allowed to use it", async () => {
    await addGitHub();
    await connect("github-oauth");
    await allow("ci");
    await grantPatCrm();
    signIn(member, "pat@acme.test");
    await connect("github-oauth");

    const mine = await listConnections(org("owner", owner));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      providerId: "github-oauth",
      userId: owner,
      // By name: ci, then crm.
      apps: [
        { rowId: rows["ci"], id: "ci", name: "ci" },
        { rowId: rows["crm"], id: "crm", name: "crm" },
      ],
      scopes: ["repo", "workflow"],
    });
    // A member sees their own; the organization's is an owner's or admin's.
    const pats = await listConnections(org("member", member));
    expect(pats).toMatchObject([
      { userId: member, apps: [{ id: "crm" }], status: "active" },
    ]);
    await expect(
      listConnections(org("member", member), { user: "all" }),
    ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    const all = await listConnections(org("owner", owner), { user: "all" });
    expect(
      Object.fromEntries(
        all.map((each) => [each.userId, each.apps.map((app) => app.id)]),
      ),
    ).toEqual({ [owner]: ["ci", "crm"], [member]: ["crm"] });
    expect(all).toHaveLength(2);
  });

  it("takes one app's access away and leaves the connection for the others; a member only their own", async () => {
    await addGitHub();
    await connect("github-oauth");
    await allow("ci");
    const [mine] = await listConnections(org("owner", owner));
    const issued = { ...github.state.tokens[0]! };

    // Pat is a member: Ben's connection isn't Pat's to change.
    for (const ref of [
      { connectionId: mine!.id },
      { providerId: "github-oauth", userId: owner },
    ]) {
      await expect(
        removeAppAccess(org("member", member), { ...ref, app: "ci" }),
      ).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });
    }
    expect(await accessRows()).toEqual([`${owner} ci`, `${owner} crm`]);

    const taken = await removeAppAccess(org("owner", owner), {
      providerId: "github-oauth",
      app: "ci",
    });
    expect(taken).toMatchObject({
      removed: true,
      connection: { id: mine!.id, apps: [{ id: "crm" }] },
    });
    expect(await accessRows()).toEqual([`${owner} crm`]);
    // The connection stays, its grant at GitHub with it, and crm uses it.
    expect(await listConnections(org("owner", owner))).toMatchObject([
      { id: mine!.id, status: "active", apps: [{ id: "crm" }] },
    ]);
    expect(github.state.revokeRequests).toEqual([]);
    expect(github.accepts(issued.accessToken)).toBe(true);
    expect(await eventTypes()).not.toContain("provider.disconnected");
    const crm = await appCall(
      "crm",
      "/api/integrations/github-oauth/api.github.com/user",
    );
    expect(crm.status).toBe(200);
    // ci asks Ben again before it uses the connection.
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

    // An app that isn't allowed has nothing to take.
    await expect(
      removeAppAccess(org("owner", owner), {
        connectionId: mine!.id,
        app: "ci",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });
    await expect(
      removeAppAccess(org("owner", owner), {
        connectionId: "conn_missing",
        app: "crm",
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_NOT_FOUND" });

    // A member takes an app off their own connection, here by its row id.
    await grantPatCrm();
    signIn(member, "pat@acme.test");
    await connect("github-oauth");
    const [pats] = await listConnections(org("member", member));
    expect(
      await removeAppAccess(org("member", member), {
        connectionId: pats!.id,
        app: rows["crm"]!,
      }),
    ).toMatchObject({ removed: true, connection: { id: pats!.id, apps: [] } });
    // An owner takes one off anyone's.
    await allow("crm");
    expect(
      await removeAppAccess(org("owner", owner), {
        providerId: "github-oauth",
        userId: member,
        app: "crm",
      }),
    ).toMatchObject({ removed: true });
    expect(await accessRows()).toEqual([`${owner} crm`]);
    expect(await listConnections(org("member", member))).toMatchObject([
      { id: pats!.id, apps: [] },
    ]);
  });

  it("disconnects: the row goes with every app's access to it, GitHub's grant is revoked with the client, the event says so and names no app", async () => {
    await addGitHub();
    await connect("github-oauth");
    await allow("ci");
    // Pat's own connection is another row: it stays.
    await grantPatCrm();
    signIn(member, "pat@acme.test");
    await connect("github-oauth");
    signIn(owner, "ben@acme.test");
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
    expect(await accessRows()).toEqual(
      [`${owner} ci`, `${owner} crm`, `${member} crm`].sort(),
    );
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "github-oauth" },
      github.fetch,
    );
    expect(result).toMatchObject({
      removed: true,
      revoked: true,
      // What was removed, as it was.
      connection: { id: mine!.id, apps: [{ id: "ci" }, { id: "crm" }] },
    });
    expect(github.state.revokeRequests).toEqual([
      { token: issued.accessToken, clientVia: "basic" },
    ]);
    expect(github.accepts(issued.accessToken)).toBe(false);
    expect(await listConnections(org("owner", owner))).toEqual([]);
    // Every app Ben allowed stops at once; Pat's connection and access stay.
    expect(await accessRows()).toEqual([`${member} crm`]);
    expect(
      await listConnections(org("owner", owner), { user: "all" }),
    ).toMatchObject([{ userId: member, apps: [{ id: "crm" }] }]);
    for (const app of ["crm", "ci"]) {
      const after = await appCall(
        app,
        "/api/integrations/github-oauth/api.github.com/user",
      );
      expect(after.status, app).toBe(409);
    }
    // One event for the connection: the provider, the account, no app.
    const disconnected = (
      await db
        .select({ data: events.data })
        .from(events)
        .where(eq(events.type, "provider.disconnected"))
    ).map((row) => JSON.parse(row.data) as Record<string, unknown>);
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]).toMatchObject({
      provider: { id: "github-oauth", name: "GitHub", kind: "oauth" },
      account: { user: { id: owner }, label: "ben" },
      revoked: true,
    });
    expect(disconnected[0]).not.toHaveProperty("app");
    // Connecting again starts over: only the app it starts in is allowed.
    await connect("github-oauth", "?app=ci");
    expect(await accessRows()).toEqual([`${owner} ci`, `${member} crm`].sort());
  });

  it("registers Google from its preset as a deploy does, then runs it on a client pasted in the UI: offline access asked, the identity read, Google's hosts reached through the proxy", async () => {
    // What a hosted deploy or a browser install of `seo` runs before it registers the app.
    const plan = await planPresetProviders({
      capabilities: {
        "google-workspace": { scopes: ["webmasters.readonly"], why: "SEO." },
        dataforseo: { access: "read" },
      },
    });
    const googleCapability = plan.lookup.get("google-workspace");
    if (googleCapability?.mode !== "oauth_client") throw new Error("preset");
    expect((await gatewayProviders()).get("google-workspace")).toBeUndefined();
    await plan.register({
      organizationId: acme,
      userId: owner,
      email: "owner@example.com",
    });
    resetGatewayProvidersForTests();
    const googleFlow = googleCapability.flow;
    const google = fakeOAuthProvider({
      authorizeUrl: googleFlow.authorizeUrl,
      tokenUrl: googleFlow.tokenUrl,
      revokeUrl: googleFlow.revokeUrl,
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
      source: "row",
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
      apps: [{ id: "seo" }],
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
    // An idle connection: its access token expired an hour ago. Google
    // answers invalid_token for that, so the disconnect revokes the grant
    // from the refresh token instead.
    expect(googleFlow.revokeUrl).toBe("https://oauth2.googleapis.com/revoke");
    await db
      .update(providerConnections)
      .set({ expiresAt: new Date(Date.now() - 3_600_000) });
    const issued = { ...google.state.tokens[0]! };
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "google-workspace" },
      fetchUpstream,
    );
    expect(result).toMatchObject({ removed: true, revoked: true });
    expect(google.state.revokeRequests).toEqual([
      {
        token: issued.refreshToken,
        clientVia: "form",
        tokenTypeHint: "refresh_token",
      },
    ]);
    expect(google.accepts(issued.accessToken)).toBe(false);
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

  describe("an MCP server's OAuth row (resource and issuer)", () => {
    const MCP_URL = "https://mcp.treg.to/mcp";
    const ISSUER = "https://auth.treg.to";
    let forms: URLSearchParams[];

    /** Treg's token endpoint: records each form, answers a token that expires in a minute. */
    const tregToken = async (request: Request): Promise<Response> => {
      forms.push(new URLSearchParams(await request.text()));
      return Response.json({
        access_token: `treg-access-${forms.length}`,
        refresh_token: "treg-refresh",
        expires_in: 60,
        scope: "mcp:tools offline",
      });
    };

    async function addTregRow(
      options: { providerId?: string; callerSlug?: string } = {},
    ) {
      const made = mcpOAuthProviderSpec({
        appId: "treg",
        name: "Treg",
        url: MCP_URL,
        discovery: {
          resource: MCP_URL,
          issuer: ISSUER,
          authorizationEndpoint: `${ISSUER}/authorize`,
          tokenEndpoint: `${ISSUER}/token`,
          scopes: ["mcp:tools"],
          tokenEndpointAuthMethods: ["client_secret_post"],
          resourceMetadata: true,
        },
        client: { hasSecret: true, inject: "form" },
      });
      if (!made.ok) throw new Error(made.problem);
      // `providerId` renames the row: an ordinary OAuth spec that sets a
      // `resource`, not any app's own MCP row.
      const providerId = options.providerId ?? "treg-mcp";
      const prefix = providerId.toUpperCase().replace(/-/g, "_");
      const spec =
        providerId === "treg-mcp"
          ? made.spec
          : {
              ...made.spec,
              id: providerId,
              auth: {
                ...(made.spec.auth as object),
                clientId: `${prefix}_CLIENT_ID`,
                clientSecret: `${prefix}_CLIENT_SECRET`,
              },
              tags: [],
            };
      await addOAuthProvider(org("owner", owner), null, {
        spec,
        clientId: "treg-client",
        clientSecret: "treg-secret",
      });
      resetGatewayProvidersForTests();
      // The remote MCP app the row is for: a provider-tier row whose
      // manifest lists it with the scopes discovery found.
      await db.insert(apps).values({
        id: "app-treg",
        organizationId: acme,
        appSlug: "treg",
        name: "Treg",
        description: "",
        tier: "provider",
        status: "active",
        manifest: JSON.stringify({
          id: "treg",
          name: "Treg",
          description: "Treg's MCP server.",
          remote: {
            url: MCP_URL,
            auth: { kind: "provider", provider: "treg-mcp" },
            risk: "annotations",
            tools: {},
            rev: 1,
          },
          capabilities: {
            [providerId]: { scopes: ["mcp:tools"], why: "Treg's tools." },
          },
        }),
      });
      // Another app that lists the row in its manifest: not its own.
      if (options.callerSlug) {
        await db.insert(apps).values({
          id: `app-${options.callerSlug}`,
          organizationId: acme,
          appSlug: options.callerSlug,
          name: "Other",
          description: "",
          status: "active",
          manifest: JSON.stringify({
            id: options.callerSlug,
            name: "Other",
            description: "Another app.",
            capabilities: {
              [providerId]: { scopes: ["mcp:tools"], why: "Treg's tools." },
            },
          }),
        });
      }
    }

    /** Start a connect; the authorize URL and the callback a server would send back. */
    async function start(
      providerId = "treg-mcp",
      slug = "treg",
    ): Promise<{ authorize: URL; state: string }> {
      const started = await serveConnectRoute(
        new Request(`${GATEWAY}/connect/${providerId}?app=${slug}`),
        { fetchUpstream: tregToken, now: () => now },
      );
      expect(started?.status).toBe(302);
      const authorize = new URL(started!.headers.get("location")!);
      return { authorize, state: authorize.searchParams.get("state")! };
    }

    function callback(state: string, extra = "", providerId = "treg-mcp") {
      return serveConnectRoute(
        new Request(
          `${GATEWAY}/connect/${providerId}/callback?code=the-code&state=${state}${extra}`,
        ),
        { fetchUpstream: tregToken, now: () => now },
      );
    }

    beforeEach(() => {
      forms = [];
    });

    it("sends resource on the authorize URL, the code exchange and every refresh, and keeps what the server granted", async () => {
      await addTregRow();
      const { authorize, state } = await start();
      expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
      expect(authorize.searchParams.get("resource")).toBe(MCP_URL);
      expect(authorize.searchParams.get("scope")).toBe("mcp:tools");
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

      // The issuer the flow is for: accepted.
      const finished = await callback(
        state,
        `&iss=${encodeURIComponent(ISSUER)}`,
      );
      expect(finished?.status).toBe(302);
      expect(forms[0]!.get("grant_type")).toBe("authorization_code");
      expect(forms[0]!.get("resource")).toBe(MCP_URL);
      expect(forms[0]!.get("code_verifier")).toBeTruthy();

      // Lenient scopes: more than asked is kept as granted, never refused.
      const [row] = await db
        .select()
        .from(providerConnections)
        .where(eq(providerConnections.providerId, "treg-mcp"));
      expect(JSON.parse(row!.scopes)).toEqual(["mcp:tools", "offline"]);
      // The connection is the person's; the MCP app it was made from is
      // allowed to use it, for the scopes it lists.
      const access = await db.select().from(providerAppAccess);
      expect(access).toMatchObject([
        { providerId: "treg-mcp", userId: owner, appRowId: "app-treg" },
      ]);
      expect(JSON.parse(access[0]!.scopes)).toEqual(["mcp:tools"]);

      // The refresh, a minute later, carries resource too.
      const registry = await gatewayProviders();
      const capability = registry.get("treg-mcp");
      if (capability?.mode !== "oauth_client") throw new Error("oauth row");
      const client = await resolveOAuthClient({
        id: "treg-mcp",
        capability,
        env: fakeEnv as never,
        lookup: registry,
      });
      const refreshed = await accessTokenFor({
        connectionId: row!.id,
        scopes: JSON.parse(row!.scopes) as string[],
        capability,
        client: client!,
        env: fakeEnv as never,
        fetchUpstream: tregToken,
        now: now + 60_000,
        log: { provider: "treg-mcp" },
      });
      expect(refreshed).toEqual({
        ok: true,
        accessToken: "treg-access-2",
        version: 1,
      });
      expect(forms[1]!.get("grant_type")).toBe("refresh_token");
      expect(forms[1]!.get("resource")).toBe(MCP_URL);
    });

    it("checks the scopes of a row that isn't the calling app's own: another app listing treg-mcp is refused, nothing stored", async () => {
      await addTregRow({ callerSlug: "other" });
      const { state } = await start("treg-mcp", "other");
      const refused = await callback(state);
      expect(refused?.status).toBe(400);
      expect(await refused?.text()).toContain("offline");
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
    });

    it("checks the scopes of an ordinary OAuth spec that sets a resource: refused, nothing stored", async () => {
      await addTregRow({ providerId: "treg-api" });
      const { state } = await start("treg-api");
      const refused = await callback(state, "", "treg-api");
      expect(refused?.status).toBe(400);
      expect(await refused?.text()).toContain("offline");
      expect(await db.select().from(providerConnections)).toEqual([]);
    });

    it("refuses a callback whose iss is another authorization server's, the state spent and nothing exchanged", async () => {
      await addTregRow();
      const { state } = await start();
      const refused = await callback(
        state,
        `&iss=${encodeURIComponent("https://evil.example")}`,
      );
      expect(refused?.status).toBe(400);
      expect(await refused?.text()).toContain("another authorization server");
      expect(forms).toEqual([]);
      expect(await db.select().from(providerConnections)).toEqual([]);
      // The state was spent: the right iss with it is refused too.
      const again = await callback(state, `&iss=${encodeURIComponent(ISSUER)}`);
      expect(again?.status).toBe(400);
      expect(await again?.text()).toContain("used already");
    });
  });
});
