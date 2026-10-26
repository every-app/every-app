/**
 * The Google-first proof of the OAuth providers swath
 * (docs/design/2026-10-oauth-providers-proof.md), as OpenSEO uses it: the
 * operator pastes a Google client for the catalog's `google-workspace`
 * entry; a member clicks Connect Google in OpenSEO, which sends them to the
 * Gateway's connect page with a return to the app; the Gateway asks Google
 * for offline access and the three sets OpenSEO declares (identity,
 * search-console.read, analytics.read) with PKCE; the callback stores the
 * connection sealed and labeled by the userinfo email; OpenSEO's Search
 * Console and Analytics reads then go through the proxy with the member's
 * token, including the read-shaped POSTs (searchAnalytics/query,
 * runReport), while a POST outside the sets is refused; the token is
 * refreshed when due; a disconnect deletes without revoking at Google.
 * Then GitHub, the proof that a provider with no hand-written entry works
 * by upload alone: the preset becomes a row, the same flow runs, the API
 * sees the bearer, and a disconnect revokes GitHub's grant.
 *
 * A fake provider stands in for Google and GitHub (src/test/
 * fake-oauth-provider.ts); the real token exchange needs Ben's client ids.
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
  CAPABILITIES,
  mintIdentityJwt,
  OAUTH_PRESETS,
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
import { serveConnectRoute } from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import {
  addOAuthProvider,
  disconnect,
  listConnections,
  listOAuthProviders,
  setOAuthClient,
} from "./service";

const GATEWAY = "https://home.example.com";
const OPENSEO_RETURN =
  "https://openseo.apps.example.com/projects/1/integrations";
const GOOGLE = CAPABILITIES["google-workspace"];
const GOOGLE_SCOPES = {
  identity: ["openid", "email", "profile"],
  searchConsole: "https://www.googleapis.com/auth/webmasters.readonly",
  analytics: "https://www.googleapis.com/auth/analytics.readonly",
};
const GITHUB = OAUTH_PRESETS["github-oauth"]! as {
  auth: { authorizeUrl: string; tokenUrl: string };
};

type Upstream = (request: Request) => Promise<Response>;

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

describe("the Google-first proof: OpenSEO through the Gateway's Google connection (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  const workers: Record<string, string> = {};
  let google: ReturnType<typeof fakeOAuthProvider>;
  let googleUpstream: Upstream;
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
    now = Date.parse("2026-10-25T21:00:00Z");
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
    // OpenSEO's manifest entry (the port's everyapp.config.ts).
    const openseo = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "openseo",
      manifest: {
        id: "openseo",
        capabilities: {
          "google-workspace": {
            access: "read",
            optional: true,
            scopes: ["identity", "search-console.read", "analytics.read"],
            why: "Search Console and GA4 reads for your sites, with the Google account you connect in EveryApp.",
          },
          "github-oauth": {
            access: "read",
            scopes: ["identity", "repo.read"],
            why: "Lists the repositories behind a site.",
          },
        },
      },
      deployerUserId: owner,
    });
    workers["openseo"] = openseo.app.workerName!;

    google = fakeOAuthProvider({
      authorizeUrl: GOOGLE.authorize.url,
      tokenUrl: GOOGLE.flow!.tokenUrl,
      apiHost: "www.googleapis.com",
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
      scopeDialect: "space",
      expiresIn: 3600,
      issueRefreshToken: true,
      rotateRefreshToken: false,
    });
    googleUpstream = async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "openidconnect.googleapis.com") {
        return Response.json({ email: "ben@gmail.test", sub: "g-4242" });
      }
      // Google's Analytics hosts answer like its Search Console host.
      if (
        url.hostname === "analyticsadmin.googleapis.com" ||
        url.hostname === "analyticsdata.googleapis.com" ||
        url.hostname === "searchconsole.googleapis.com"
      ) {
        url.hostname = "www.googleapis.com";
        return google.fetch(new Request(url, request));
      }
      return google.fetch(request);
    };
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
  function browse(path: string, fetchUpstream: Upstream) {
    return serveConnectRoute(new Request(`${GATEWAY}${path}`), {
      fetchUpstream,
      now: () => now,
    });
  }

  /** An OpenSEO call through the AppGateway entrypoint, as a person or as background work. */
  async function appCall(
    path: string,
    options: {
      user?: string | null;
      method?: string;
      headers?: Record<string, string>;
      fetchUpstream: Upstream;
      body?: string;
    },
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
          audience: workers["openseo"]!,
          issuer: GATEWAY,
          now,
        }),
      );
    }
    if (options.body) headers.set("content-type", "application/json");
    const { fetchUpstream } = options;
    return handleAppGatewayRequest({
      request: new Request(`http://every-app-gateway.internal${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body ? { body: options.body } : {}),
      }),
      props: {
        organizationId: acme,
        appId: "openseo",
        workerName: workers["openseo"],
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

  async function eventTypes(): Promise<string[]> {
    const rows = await db.select({ type: events.type }).from(events);
    return rows.map((row) => row.type);
  }

  /** The operator pastes the Google client in Admin → Providers. */
  async function uploadGoogleClient() {
    const summary = await setOAuthClient(
      org("owner", owner),
      null,
      "google-workspace",
      { clientId: "google-client-id", clientSecret: "google-client-secret" },
    );
    resetGatewayProvidersForTests();
    return summary;
  }

  it("Google first: the client pasted for the catalog entry, Connect Google from OpenSEO, the three sets, the sealed connection, Search Console and Analytics reads through the proxy, the refresh, the disconnect without a revoke", async () => {
    // 1. Before a client exists OpenSEO reads Google as not available.
    const before = await appCall("/api/integrations/google-workspace", {
      fetchUpstream: googleUpstream,
    });
    await expect(before.json()).resolves.toMatchObject({
      capability: "google-workspace",
      requested: true,
      configured: false,
      ready: false,
    });

    // 2. The operator pastes the client: the catalog entry, no row, one client.
    const uploaded = await uploadGoogleClient();
    expect(uploaded).toMatchObject({
      id: "google-workspace",
      source: "catalog",
      kind: "oauth",
      flow: "both",
      bound: true,
      client: { source: "d1", clientId: "google-client-id" },
      redirectUri: `${GATEWAY}/connect/google-workspace/callback`,
      connections: 0,
    });
    expect(JSON.stringify(uploaded)).not.toContain("google-client-secret");
    const providers = await listOAuthProviders(org("owner", owner));
    expect(
      providers.filter((each) => each.id === "google-workspace"),
    ).toHaveLength(1);

    // 3. OpenSEO shows Connect Google: available, not connected yet.
    const unconnected = await appCall("/api/integrations/google-workspace", {
      fetchUpstream: googleUpstream,
    });
    await expect(unconnected.json()).resolves.toMatchObject({
      configured: true,
      ready: false,
      flow: "both",
      connectPath: "/connect/google-workspace",
      scopeSets: ["identity", "search-console.read", "analytics.read"],
      connection: null,
    });

    // 4. The member clicks Connect Google: OpenSEO's connectUrl() sends the
    //    browser to the Gateway with a return to the page they were on.
    const started = await browse(
      `/connect/google-workspace?return=${encodeURIComponent(OPENSEO_RETURN)}&account=user`,
      googleUpstream,
    );
    expect(started?.status).toBe(302);
    const authorize = new URL(started!.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(GOOGLE.authorize.url);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: "google-client-id",
      redirect_uri: `${GATEWAY}/connect/google-workspace/callback`,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });
    expect(params["code_challenge"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params["state"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The union of the sets OpenSEO declares, in Google's spelling.
    const asked = params["scope"]!.split(" ");
    expect(asked).toEqual(
      expect.arrayContaining([
        ...GOOGLE_SCOPES.identity,
        GOOGLE_SCOPES.searchConsole,
        GOOGLE_SCOPES.analytics,
      ]),
    );
    expect(asked).not.toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );

    // 5. Google answers; the callback exchanges the code with PKCE and the
    //    client in the form body, reads the identity, stores the connection.
    const back = google.authorize(authorize);
    const finished = await browse(back.pathname + back.search, googleUpstream);
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe(OPENSEO_RETURN);
    expect(google.state.tokenRequests[0]).toMatchObject({
      grantType: "authorization_code",
      clientVia: "form",
      clientId: "google-client-id",
      clientSecretPresent: true,
      redirectUri: `${GATEWAY}/connect/google-workspace/callback`,
    });
    expect(google.state.tokenRequests[0]!.codeVerifier).toBeTruthy();
    const issued = { ...google.state.tokens[0]! };
    const [row] = await db
      .select()
      .from(providerConnections)
      .where(eq(providerConnections.providerId, "google-workspace"));
    expect(row).toMatchObject({
      organizationId: acme,
      accountKind: "user",
      subject: owner,
      userId: owner,
      label: "ben@gmail.test",
      externalId: "g-4242",
      status: "active",
    });
    expect(JSON.parse(row!.scopeSets)).toEqual([
      "identity",
      "search-console.read",
      "analytics.read",
    ]);
    expect(isSealed(row!.accessTokenEnc)).toBe(true);
    expect(isSealed(row!.refreshTokenEnc!)).toBe(true);
    expect(row!.accessTokenEnc).not.toContain(issued.accessToken);
    expect(await eventTypes()).toContain("provider.connected");

    // 6. OpenSEO now reads Google as connected, for this member.
    const connected = await appCall("/api/integrations/google-workspace", {
      fetchUpstream: googleUpstream,
    });
    const connectedBody = await connected.text();
    expect(JSON.parse(connectedBody)).toMatchObject({
      ready: true,
      connection: {
        account: "user",
        label: "ben@gmail.test",
        scopeSets: ["identity", "search-console.read", "analytics.read"],
        ready: true,
      },
    });
    expect(connectedBody).not.toContain(issued.accessToken);
    // Another member has no connection of their own.
    const pats = await appCall("/api/integrations/google-workspace", {
      user: member,
      fetchUpstream: googleUpstream,
    });
    await expect(pats.json()).resolves.toMatchObject({
      ready: false,
      connection: null,
    });

    // 7. OpenSEO's gscClient and ga4Client calls (the port's
    //    src/server/lib/gscClient.ts, ga4Client.ts), token-free, through the proxy.
    const sites = await appCall(
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites",
      {
        fetchUpstream: googleUpstream,
        headers: { authorization: "Bearer app" },
      },
    );
    expect(sites.status).toBe(200);
    expect(google.state.apiRequests.at(-1)).toMatchObject({
      method: "GET",
      url: "https://www.googleapis.com/webmasters/v3/sites",
      bearer: issued.accessToken,
    });
    const query = await appCall(
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fx%2F/searchAnalytics/query",
      {
        method: "POST",
        fetchUpstream: googleUpstream,
        body: JSON.stringify({
          startDate: "2026-10-01",
          endDate: "2026-10-07",
        }),
      },
    );
    expect(query.status).toBe(200);
    expect(google.state.apiRequests.at(-1)).toMatchObject({
      method: "POST",
      bearer: issued.accessToken,
    });
    const inspect = await appCall(
      "/api/integrations/google-workspace/searchconsole.googleapis.com/v1/urlInspection/index:inspect",
      {
        method: "POST",
        fetchUpstream: googleUpstream,
        body: JSON.stringify({
          inspectionUrl: "https://x/",
          siteUrl: "https://x/",
        }),
      },
    );
    expect(inspect.status).toBe(200);
    const summaries = await appCall(
      "/api/integrations/google-workspace/analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
      { fetchUpstream: googleUpstream },
    );
    expect(summaries.status).toBe(200);
    const report = await appCall(
      "/api/integrations/google-workspace/analyticsdata.googleapis.com/v1beta/properties/42:runReport",
      {
        method: "POST",
        fetchUpstream: googleUpstream,
        body: JSON.stringify({ metrics: [{ name: "sessions" }] }),
      },
    );
    expect(report.status).toBe(200);
    const userinfo = await appCall(
      "/api/integrations/google-workspace/openidconnect.googleapis.com/v1/userinfo",
      { fetchUpstream: googleUpstream },
    );
    expect(userinfo.status).toBe(200);
    await expect(userinfo.json()).resolves.toMatchObject({
      email: "ben@gmail.test",
    });
    for (const api of google.state.apiRequests) {
      expect(api.headers["x-everyapp-identity"]).toBeUndefined();
      expect(api.headers["cookie"]).toBeUndefined();
    }

    // 8. Outside the sets: Gmail is not a set OpenSEO declares, a write on a
    //    read grant is refused, and the token endpoint is never a proxy target.
    const gmail = await appCall(
      "/api/integrations/google-workspace/gmail.googleapis.com/gmail/v1/users/me/messages",
      { fetchUpstream: googleUpstream },
    );
    expect(gmail.status).toBe(403);
    expect(gmail.headers.get("x-everyapp-error")).toBe(
      "integration_scope_not_allowed",
    );
    const deleteSite = await appCall(
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fx%2F",
      { method: "DELETE", fetchUpstream: googleUpstream },
    );
    expect([403, 405]).toContain(deleteSite.status);
    const apiCallsSoFar = google.state.counters.api;

    // 9. Due for a refresh: Google keeps the refresh token; the new access token is sealed and used.
    const connection = (await listConnections(org("owner", owner)))[0]!;
    await ProviderConnectionRepository.storeTokens(
      connection.id,
      {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: Date.now() + 10_000,
      },
      fakeEnv,
    );
    const afterRefresh = await appCall(
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites",
      { fetchUpstream: googleUpstream },
    );
    expect(afterRefresh.status).toBe(200);
    expect(google.state.counters.refresh).toBe(1);
    expect(google.state.tokenRequests.at(-1)).toMatchObject({
      grantType: "refresh_token",
      refreshToken: issued.refreshToken,
      clientVia: "form",
    });
    const fresh = google.state.tokens.at(-1)!;
    expect(fresh.accessToken).not.toBe(issued.accessToken);
    expect(google.state.apiRequests.at(-1)!.bearer).toBe(fresh.accessToken);
    expect(google.state.counters.api).toBe(apiCallsSoFar + 1);
    const stored = await ProviderConnectionRepository.readTokens(
      connection.id,
      fakeEnv,
    );
    expect(stored?.accessToken).toBe(fresh.accessToken);
    expect(stored?.refreshToken).toBe(issued.refreshToken);

    // 10. Disconnect: the row goes, nothing is revoked at Google.
    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "google-workspace", account: "user" },
      googleUpstream,
    );
    expect(result).toEqual({ removed: true, revoked: false });
    expect(google.state.counters.revoke).toBe(0);
    expect(await listConnections(org("owner", owner))).toEqual([]);
    expect(await eventTypes()).toContain("provider.disconnected");
    const gone = await appCall("/api/integrations/google-workspace", {
      fetchUpstream: googleUpstream,
    });
    await expect(gone.json()).resolves.toMatchObject({
      configured: true,
      ready: false,
      connection: null,
    });
    const refused = await appCall(
      "/api/integrations/google-workspace/www.googleapis.com/webmasters/v3/sites",
      { fetchUpstream: googleUpstream },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/google-workspace",
    });
  });

  it("GitHub second: a provider with no hand-written entry, by upload alone", async () => {
    const added = await addOAuthProvider(org("owner", owner), null, {
      preset: "github-oauth",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
    });
    resetGatewayProvidersForTests();
    expect(added).toMatchObject({
      id: "github-oauth",
      name: "GitHub",
      source: "row",
      flow: "both",
      bound: true,
      client: { source: "d1", clientId: "gh-client-id" },
      redirectUri: `${GATEWAY}/connect/github-oauth/callback`,
    });

    const started = await browse(
      `/connect/github-oauth?return=${encodeURIComponent(OPENSEO_RETURN)}`,
      github.fetch,
    );
    expect(started?.status).toBe(302);
    const authorize = new URL(started!.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe(
      GITHUB.auth.authorizeUrl,
    );
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      client_id: "gh-client-id",
      redirect_uri: `${GATEWAY}/connect/github-oauth/callback`,
      code_challenge_method: "S256",
    });
    expect(params["scope"]).toBe("read:user,user:email,repo");
    const back = github.authorize(authorize);
    const finished = await browse(back.pathname + back.search, github.fetch);
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe(OPENSEO_RETURN);
    expect(github.state.tokenRequests[0]!.headers["accept"]).toBe(
      "application/json",
    );
    expect((await listConnections(org("owner", owner)))[0]).toMatchObject({
      providerId: "github-oauth",
      label: "ben",
      scopeSets: ["identity", "repo.read"],
    });

    const repos = await appCall(
      "/api/integrations/github-oauth/api.github.com/user/repos?per_page=5",
      { fetchUpstream: github.fetch },
    );
    expect(repos.status).toBe(200);
    expect(github.state.apiRequests.at(-1)).toMatchObject({
      url: "https://api.github.com/user/repos?per_page=5",
      bearer: github.state.tokens[0]!.accessToken,
    });

    const result = await disconnect(
      org("owner", owner),
      null,
      { providerId: "github-oauth", account: "user" },
      github.fetch,
    );
    expect(result).toEqual({ removed: true, revoked: true });
    expect(github.state.counters.revoke).toBe(1);
  });
});
