/**
 * Background use of a member's own OAuth connection end to end against a
 * migrated SQLite database and a fake GitHub
 * (docs/design/2026-11-birds-decisions/888-background-oauth.md): the
 * Gateway's consent page and its form, the held-token proxy's background
 * branch with its per-call re-checks, revocation by the member and by an
 * admin, the idle lapse, the hourly sweep, the disconnect, and the events.
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

import { mintIdentityJwt } from "@every-app/sdk/internal";
import { and, eq } from "drizzle-orm";
import {
  apps,
  events,
  providerBackgroundGrants,
  userAppAccess,
} from "@/db/schema";
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
import { BackgroundGrantRepository } from "@/server/repositories/BackgroundGrantRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { fakeOAuthProvider } from "@/test/fake-oauth-provider";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  gatewayBackgroundGrants,
  lapseBackgroundGrants,
  listBackgroundGrants,
  revokeBackgroundGrant,
} from "./background";
import { noteMemberSeen } from "./backgroundSeen";
import { resolveOAuthClient } from "./client";
import { serveConnectRoute } from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import { addOAuthProvider, disconnect } from "./service";

const GATEWAY = "https://home.example.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_READ = "/api/integrations/github-oauth/api.github.com/user/repos";
const ISSUES =
  "/api/integrations/github-oauth/api.github.com/repos/acme/site/issues";

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

describe("background use of a member's connection (SQLite)", () => {
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
    now = Date.parse("2026-11-01T12:00:00Z");
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
        "agent",
        {
          "github-oauth": {
            access: "write",
            scopes: ["identity", "repo.read", "repo.write"],
            background: {
              scopes: ["repo.read"],
              why: "Keeps your personal agent's repository list current.",
            },
          },
        },
      ],
      [
        "crm",
        {
          "github-oauth": { access: "read", scopes: ["identity", "repo.read"] },
        },
      ],
    ] as const) {
      const plan = await deployLiveApp(db, {
        organizationId: acme,
        appSlug,
        manifest: { id: appSlug, name: appSlug, capabilities },
        deployerUserId: owner,
      });
      workers[appSlug] = plan.app.workerName!;
      rows[appSlug] = plan.app.id;
      for (const userId of [owner]) {
        const has = await db
          .select({ id: userAppAccess.id })
          .from(userAppAccess)
          .where(
            and(
              eq(userAppAccess.userId, userId),
              eq(userAppAccess.appRowId, plan.app.id),
            ),
          );
        if (has.length === 0) {
          await db.insert(userAppAccess).values({
            id: `uaa_${appSlug}_${userId}`,
            userId,
            appRowId: plan.app.id,
            organizationId: acme,
          });
        }
      }
    }
    github = fakeOAuthProvider({
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      apiHost: "api.github.com",
      clientId: "gh-client-id",
      clientSecret: "gh-client-secret",
      scopeDialect: "comma",
      revokeUrl: "https://api.github.com/applications/gh-client-id/grant",
      identity: { path: "/user", body: { login: "ben", id: 4242 } },
    });
    signIn(owner, "ben@acme.test");
    await addOAuthProvider(
      { orgId: acme, userId: owner, role: "owner" },
      null,
      {
        preset: "github-oauth",
        clientId: "gh-client-id",
        clientSecret: "gh-client-secret",
      },
    );
    resetGatewayProvidersForTests();
  });

  function signIn(userId: string, email: string) {
    session.current = {
      user: { id: userId, email },
      session: { activeOrganizationId: acme },
    };
  }

  function browse(path: string, init?: RequestInit) {
    return serveConnectRoute(new Request(`${GATEWAY}${path}`, init), {
      fetchUpstream: github.fetch,
      now: () => now,
    });
  }

  async function connect(): Promise<void> {
    const started = await browse("/connect/github-oauth");
    expect(started?.status).toBe(302);
    const back = github.authorize(started!.headers.get("location")!);
    const finished = await serveConnectRoute(new Request(back), {
      fetchUpstream: github.fetch,
      now: () => now,
    });
    expect(finished?.status).toBe(302);
  }

  /** The page's own form POST. */
  function decide(
    fields: Record<string, string>,
    headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
  ) {
    return browse("/connect/github-oauth/background", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  async function allow(): Promise<void> {
    const page = await browse("/connect/github-oauth/background?app=agent");
    expect(page?.status).toBe(200);
    const decided = await decide({
      app: "agent",
      sets: "repo.read",
      return: "/settings/accounts",
      decision: "allow",
    });
    expect(decided?.status).toBe(302);
  }

  /** An app's call: background work naming `onBehalfOf`, or a person's. */
  async function appCall(
    appSlug: string,
    path: string,
    options: {
      onBehalfOf?: string;
      person?: string;
      method?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    clearAppCallerCacheForTests();
    const headers = new Headers(options.headers);
    if (options.onBehalfOf) headers.set("x-everyapp-user", options.onBehalfOf);
    if (options.person) {
      headers.set(
        "x-everyapp-identity",
        await mintIdentityJwt(privateKeyPem, {
          subject: {
            sub: options.person,
            email: "ben@acme.test",
            orgId: acme,
            orgRole: "owner",
          },
          audience: workers[appSlug]!,
          issuer: GATEWAY,
          now,
        }),
      );
    }
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
      fetchUpstream: github.fetch,
      providers: gatewayProviders,
      oauth: async () => ({
        resolveClient: resolveOAuthClient,
        connections: gatewayHeldTokens({ fetchUpstream: github.fetch }),
        backgroundFor: gatewayBackgroundGrants,
      }),
    });
  }

  async function eventTypes(): Promise<string[]> {
    const found = await db.select({ type: events.type }).from(events);
    return found.map((row) => row.type);
  }

  it("refuses a background call naming a member until they allow it on the Gateway's page, then serves the background sets only (`oauth.background-needs-member-opt-in`)", async () => {
    await connect();
    const before = await appCall("agent", REPO_READ, { onBehalfOf: owner });
    expect(before.status).toBe(409);
    await expect(before.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      background: true,
      connectPath: "/connect/github-oauth/background?app=agent",
      missingSets: ["repo.read"],
    });
    const calls = github.state.apiRequests.length;

    const page = await browse("/connect/github-oauth/background?app=agent");
    expect(page?.status).toBe(200);
    const html = await page!.text();
    expect(html).toContain("agent");
    expect(html).toContain("ben");
    expect(html).toContain(
      "Keeps your personal agent&#39;s repository list current.",
    );
    expect(html).toContain('value="allow"');
    expect(html).toContain('value="cancel"');

    const decided = await decide({
      app: "agent",
      sets: "repo.read",
      return: "/settings/accounts",
      decision: "allow",
    });
    expect(decided?.status).toBe(302);
    expect(decided?.headers.get("location")).toBe("/settings/accounts");
    expect(await eventTypes()).toContain("provider.background_granted");

    const repos = await appCall("agent", REPO_READ, { onBehalfOf: owner });
    expect(repos.status).toBe(200);
    expect(github.state.apiRequests.length).toBe(calls + 1);
    expect(
      github.state.apiRequests.at(-1)!.headers["x-everyapp-user"],
    ).toBeUndefined();
    // A write is outside the background sets, even though the entry may write in session.
    const write = await appCall("agent", ISSUES, {
      onBehalfOf: owner,
      method: "POST",
    });
    expect(write.status).toBe(403);
    expect(write.headers.get("x-everyapp-error")).toBe(
      "integration_scope_not_allowed",
    );
    // Another app that marks no background sets gets nothing, nor another member.
    const crm = await appCall("crm", REPO_READ, { onBehalfOf: owner });
    expect(crm.status).toBe(403);
    const pat = await appCall("agent", REPO_READ, { onBehalfOf: member });
    expect(pat.status).toBe(409);
    // A person's own call may not name someone else.
    const mixed = await appCall("agent", REPO_READ, {
      onBehalfOf: member,
      person: owner,
    });
    expect(mixed.status).toBe(400);
    // The first background call of the day is the audit log's connection.used.
    expect(
      (await eventTypes()).filter((type) => type === "connection.used"),
    ).toHaveLength(1);
  });

  it("records a decision only from the page's own form, re-reading the sets the manifest marks (`oauth.background-consent-on-gateway-page`)", async () => {
    await connect();
    const forged = await decide(
      { app: "agent", sets: "repo.read", decision: "allow" },
      { "sec-fetch-site": "cross-site" },
    );
    expect(forged?.status).toBe(403);
    const widened = await decide({
      app: "agent",
      sets: "repo.read,repo.write",
      decision: "allow",
    });
    expect(widened?.status).toBe(302);
    expect(widened?.headers.get("location")).toContain(
      "/connect/github-oauth/background?",
    );
    const cancel = await decide({
      app: "agent",
      sets: "repo.read",
      return: "https://evil.example.net/",
      decision: "cancel",
    });
    expect(cancel?.headers.get("location")).toBe("/settings/accounts");
    expect(await db.select().from(providerBackgroundGrants)).toHaveLength(0);
    // An app that marks no background sets has no page.
    const crm = await browse("/connect/github-oauth/background?app=crm");
    expect(crm?.status).toBe(409);
    // Someone who can't open the app has no page either.
    signIn(member, "pat@acme.test");
    const noAccess = await browse("/connect/github-oauth/background?app=agent");
    expect(noAccess?.status).toBe(403);
  });

  it("sends a member with no connection to connect first, then back to the page", async () => {
    const page = await browse("/connect/github-oauth/background?app=agent");
    expect(page?.status).toBe(302);
    const location = page!.headers.get("location")!;
    expect(location.startsWith("/connect/github-oauth?")).toBe(true);
    const back = new URL(location, GATEWAY).searchParams.get("return")!;
    expect(back).toContain("/connect/github-oauth/background?app=agent");
    expect(back).toContain("connected=1");
  });

  it("ends on the member's revoke, an admin's revoke and a disconnect, each in the audit log (`oauth.background-revocable`)", async () => {
    await connect();
    await allow();
    const [grant] = await listBackgroundGrants({
      organizationId: acme,
      userId: owner,
    });
    expect(grant).toMatchObject({
      app: { id: "agent" },
      scopeSets: ["repo.read"],
    });
    // A member can't revoke another's.
    expect(
      await revokeBackgroundGrant({
        grantId: grant!.id,
        organizationId: acme,
        actorUserId: member,
        asAdmin: false,
      }),
    ).toBe(false);
    expect(
      await revokeBackgroundGrant({
        grantId: grant!.id,
        organizationId: acme,
        actorUserId: owner,
        asAdmin: false,
      }),
    ).toBe(true);
    expect(
      (await appCall("agent", REPO_READ, { onBehalfOf: owner })).status,
    ).toBe(409);
    expect(await eventTypes()).toContain("provider.background_revoked");

    // Allowed again (the same row), then revoked by an admin on a member's behalf.
    await allow();
    const again = await BackgroundGrantRepository.listForUser(owner, acme);
    expect(again.map((row) => row.id)).toEqual([grant!.id]);
    expect(
      await revokeBackgroundGrant({
        grantId: grant!.id,
        organizationId: "another-org",
        actorUserId: owner,
        asAdmin: true,
      }),
    ).toBe(false);

    // A disconnect ends it with the connection.
    await disconnect(
      { orgId: acme, userId: owner, role: "owner" },
      null,
      {
        providerId: "github-oauth",
        account: "user",
      },
      github.fetch,
    );
    expect(await BackgroundGrantRepository.listForUser(owner, acme)).toEqual(
      [],
    );
    const ended = await db.select().from(providerBackgroundGrants);
    expect(ended[0]?.endedReason).toBe("disconnected");
    expect(await eventTypes()).toContain("provider.background_lapsed");
  });

  it("lapses after 90 days in which the member never opened the app, and when access goes (`oauth.background-lapses`)", async () => {
    await connect();
    await allow();
    // Opening the app keeps it alive.
    vi.setSystemTime(now + 60 * DAY_MS);
    noteMemberSeen(owner, rows["agent"]!);
    await vi.waitFor(async () => {
      const [row] = await db.select().from(providerBackgroundGrants);
      expect(row!.lastSeenAt.getTime()).toBe(now + 60 * DAY_MS);
    });
    vi.setSystemTime(now + 140 * DAY_MS);
    expect(
      (await appCall("agent", REPO_READ, { onBehalfOf: owner })).status,
    ).toBe(200);
    vi.setSystemTime(now + 151 * DAY_MS);
    const idle = await appCall("agent", REPO_READ, { onBehalfOf: owner });
    expect(idle.status).toBe(409);
    const [lapsed] = await db.select().from(providerBackgroundGrants);
    expect(lapsed?.endedReason).toBe("idle");

    // Allowed again, then the member loses the app: the call and the sweep both stop it.
    await allow();
    await db
      .delete(userAppAccess)
      .where(eq(userAppAccess.appRowId, rows["agent"]!));
    expect(
      (await appCall("agent", REPO_READ, { onBehalfOf: owner })).status,
    ).toBe(409);
    expect(await lapseBackgroundGrants()).toBe(1);
    const [row] = await db.select().from(providerBackgroundGrants);
    expect(row?.endedReason).toBe("no_access");
  });

  it("ends grants for a disabled app in the hourly sweep", async () => {
    await connect();
    await allow();
    await db
      .update(apps)
      .set({ status: "disabled" })
      .where(eq(apps.id, rows["agent"]!));
    expect(await lapseBackgroundGrants()).toBe(1);
    const [row] = await db.select().from(providerBackgroundGrants);
    expect(row?.endedReason).toBe("app_removed");
  });

  it("reports in the status whether the person allowed background use", async () => {
    await connect();
    const before = await appCall("agent", "/api/integrations/github-oauth", {
      person: owner,
    });
    await expect(before.json()).resolves.toMatchObject({
      connection: {
        background: {
          allowed: false,
          sets: ["repo.read"],
          connectPath: "/connect/github-oauth/background?app=agent",
        },
      },
    });
    await allow();
    const after = await appCall("agent", "/api/integrations/github-oauth", {
      person: owner,
    });
    await expect(after.json()).resolves.toMatchObject({
      connection: { background: { allowed: true } },
    });
  });
});
