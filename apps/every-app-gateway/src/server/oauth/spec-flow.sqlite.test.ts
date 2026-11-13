/**
 * One OAuth provider driven only by its spec
 * (docs/design/2026-11-oauth-one-connection.md), end to end against a
 * migrated SQLite database and the fake provider: nothing here names
 * Google, GitHub or any other provider. A person has one connection to the
 * provider, and each app they allow uses it. The first connect asks for
 * the scopes of every app in the organization plus the spec's identity
 * scopes, and allows the app it started in; a later app is allowed on the
 * Gateway's own page, with no trip to the provider; an app the person
 * hasn't allowed gets nothing. A token carrying more than was asked is
 * refused at mint and at refresh; the proxy puts the token on calls to the
 * spec's hosts alone; an organization's own app may use another member's
 * connection by naming them, a shared app and linked dev may not; and the
 * lifecycle takes an app's access away with the app or the member's access
 * to it, and the connection with the member.
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
const background = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(testDb) };
});
vi.mock("cloudflare:workers", () => ({
  env: fakeEnv,
  waitUntil: (task: Promise<unknown>) => background.push(task),
  WorkerEntrypoint: class {},
}));
vi.mock("@/auth", () => ({
  auth: { api: { getSession: async () => session.current } },
}));

import {
  CATALOG,
  mintIdentityJwt,
  OAuthClientSource,
  parseProviderSpec,
  type CapabilityLookup,
  type EveryAppUser,
} from "@every-app/sdk/internal";
import { and, eq } from "drizzle-orm";
import {
  events,
  oauthStates,
  providerAppAccess,
  providerConnections,
  userAppAccess,
} from "@/db/schema";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import {
  clearAppCallerCacheForTests,
  handleAppGatewayRequest,
} from "@/server/app-gateway-entrypoint";
import { handleIntegrationProxyRequest } from "@/server/integration-proxy";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import {
  gatewayProviders,
  resetGatewayProvidersForTests,
} from "@/server/providers";
import { AppRepository } from "@/server/repositories/AppRepository";
import { OrganizationMembersRepository } from "@/server/repositories/OrganizationMembersRepository";
import { OrganizationRepository } from "@/server/repositories/OrganizationRepository";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { UserRepository } from "@/server/repositories/UserRepository";
import { fakeOAuthProvider } from "@/test/fake-oauth-provider";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { memberMayUseApp } from "./appAccess";
import { serveConnectRoute } from "./flow";
import { addOAuthProvider, listConnections } from "./service";

const GATEWAY = "https://home.example.com";
const PREFIX = "https://acme-mail.example/scopes/";
const MESSAGES =
  "/api/integrations/acme-mail/api.acme-mail.example/v1/messages";
/** A provider no code knows: everything about it is this spec. */
const SPEC = {
  id: "acme-mail",
  name: "Acme Mail",
  description: "Mail at Acme, as the person who connects.",
  docs: "https://console.acme-mail.example/apps",
  hosts: ["api.acme-mail.example"],
  auth: {
    kind: "oauth2-user",
    authorizeUrl: "https://auth.acme-mail.example/authorize",
    tokenUrl: "https://auth.acme-mail.example/token",
    clientId: "ACME_MAIL_CLIENT_ID",
    clientSecret: "ACME_MAIL_CLIENT_SECRET",
    inject: "basic",
    pkce: true,
    scopeSeparator: "space",
    scopePrefix: PREFIX,
    authorizeParams: { access_type: "offline" },
    identity: {
      url: "https://api.acme-mail.example/me",
      label: "email",
      id: "id",
      scopes: ["profile"],
    },
  },
} as const;
const specCapability = (() => {
  const parsed = parseProviderSpec(SPEC);
  if (!parsed.ok || parsed.capability.mode !== "oauth_client") {
    throw new Error("spec");
  }
  return parsed.capability;
})();
/** What the one connection holds: every scope the organization's apps list, and the identity scope. */
const HELD = ["mail.read", "mail.send", "contacts.read", "profile"];

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

/** Every task the code queued for after the response, drained. */
async function settle(): Promise<void> {
  while (background.length > 0) {
    await Promise.allSettled(background.splice(0));
  }
}

describe("an OAuth provider driven by its spec (SQLite)", () => {
  let db: TestDb;
  let acme: string;
  let owner: string;
  let member: string;
  const workers: Record<string, string> = {};
  const rows: Record<string, string> = {};
  let provider: ReturnType<typeof fakeOAuthProvider>;
  let now: number;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Deploy an app that lists the provider for `scopes` (or not at all). */
  async function deploy(
    appSlug: string,
    scopes: string[] | null,
    providerId = "acme-mail",
  ) {
    const plan = await deployLiveApp(db, {
      organizationId: acme,
      appSlug,
      manifest: {
        id: appSlug,
        capabilities: scopes
          ? { [providerId]: { scopes, why: `What ${appSlug} does with it.` } }
          : {},
      },
      deployerUserId: owner,
    });
    workers[appSlug] = plan.app.workerName!;
    rows[appSlug] = plan.app.id;
  }

  beforeEach(async () => {
    db = await createTestDb();
    testDb.current = db;
    background.length = 0;
    clearAppCallerCacheForTests();
    clearOrgContextCacheForTests();
    resetGatewayProvidersForTests();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    now = Date.parse("2026-11-02T20:00:00Z");
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
    // Two apps list the provider, for different scopes; one doesn't.
    await deploy("mail", ["mail.read", "mail.send"]);
    await deploy("notes", ["mail.read", "contacts.read"]);
    await deploy("other", null);
    // Pat opens mail too.
    await db.insert(userAppAccess).values({
      id: "grant-pat-mail",
      organizationId: acme,
      userId: member,
      appRowId: rows["mail"]!,
    });
    provider = fakeOAuthProvider({
      authorizeUrl: SPEC.auth.authorizeUrl,
      tokenUrl: SPEC.auth.tokenUrl,
      apiHost: "api.acme-mail.example",
      clientId: "acme-client-id",
      clientSecret: "acme-client-secret",
      scopeDialect: "space",
      identity: { path: "/me", body: { email: "inbox@acme.test", id: 7 } },
    });
    await addOAuthProvider(
      { orgId: acme, userId: owner, role: "owner" } as never,
      null,
      {
        spec: SPEC,
        clientId: "acme-client-id",
        clientSecret: "acme-client-secret",
      },
    );
    resetGatewayProvidersForTests();
    signIn(owner, "ben@acme.test");
  });

  function signIn(userId: string, email: string) {
    session.current = {
      user: { id: userId, email },
      session: { activeOrganizationId: acme },
    };
  }

  type Upstream = (request: Request) => Promise<Response>;

  /** The provider, with its identity endpoint answering as another account. */
  const asAccount =
    (account: { email: string; id: number }): Upstream =>
    async (request) =>
      new URL(request.url).pathname === "/me"
        ? Response.json(account)
        : provider.fetch(request);

  /** The provider, with its identity endpoint failing: the tokens are good, the account unnamed. */
  const unnamed: Upstream = async (request) =>
    new URL(request.url).pathname === "/me"
      ? new Response("unavailable", { status: 503 })
      : provider.fetch(request);

  function browse(path: string, fetchUpstream: Upstream = provider.fetch) {
    return serveConnectRoute(new Request(`${GATEWAY}${path}`), {
      fetchUpstream,
      now: () => now,
    });
  }

  /** Connect the signed-in person from inside `app`, through the provider; the final redirect. */
  async function connect(
    app: string,
    fetchUpstream: Upstream = provider.fetch,
  ): Promise<Response> {
    const started = await browse(`/connect/acme-mail?app=${app}`);
    expect(started?.status).toBe(302);
    const back = provider.authorize(started!.headers.get("location")!);
    return (await browse(back.pathname + back.search, fetchUpstream))!;
  }

  /** The scopes an authorize URL asks the provider for, sorted. */
  function scopesAsked(authorize: URL): string[] {
    return (authorize.searchParams.get("scope") ?? "").split(" ").sort();
  }

  /**
   * Start a connect for an app whose scopes the person's connection
   * already holds: the state of the Gateway's own Allow page it leads to.
   */
  async function allowState(
    app: string,
    returnTo?: string,
    providerId = "acme-mail",
  ): Promise<string> {
    const started = await browse(
      `/connect/${providerId}?app=${app}${returnTo ? `&return=${encodeURIComponent(returnTo)}` : ""}`,
    );
    expect(started?.status).toBe(302);
    const page = new URL(started!.headers.get("location")!, GATEWAY);
    expect(page.origin + page.pathname).toBe(`${GATEWAY}/oauth/app-access`);
    return page.searchParams.get("state")!;
  }

  /** The Allow page's form, posted by the signed-in person. */
  function decide(
    state: string,
    decision: "approve" | "deny",
    providerId = "acme-mail",
  ) {
    return serveConnectRoute(
      new Request(`${GATEWAY}/connect/${providerId}/allow`, {
        method: "POST",
        body: new URLSearchParams({ state, decision }),
      }),
      { fetchUpstream: provider.fetch, now: () => now },
    );
  }

  /** The signed-in person allows `app` on the Allow page. */
  async function allow(app: string, providerId = "acme-mail"): Promise<void> {
    const answered = await decide(
      await allowState(app, undefined, providerId),
      "approve",
      providerId,
    );
    expect(answered?.status).toBe(303);
  }

  /** An app's call through the AppGateway entrypoint, as a person or as background work. */
  async function appCall(
    appSlug: string,
    path: string,
    options: {
      user?: string | null;
      method?: string;
      headers?: Record<string, string>;
      trusted?: { organizationId: string; user: EveryAppUser };
    } = {},
  ): Promise<Response> {
    clearAppCallerCacheForTests();
    const headers = new Headers(options.headers);
    const userId = options.user === undefined ? owner : options.user;
    if (userId && !options.trusted) {
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
      fetchUpstream: provider.fetch,
      providers: gatewayProviders,
      ...(options.trusted ? { trusted: options.trusted } : {}),
    });
  }

  async function eventsOf(type: string) {
    await settle();
    const rows = await db
      .select({ type: events.type, data: events.data })
      .from(events)
      .where(eq(events.type, type));
    return rows.map((row) => JSON.parse(row.data) as Record<string, unknown>);
  }

  /** The person's one connection to the provider. */
  function connectionOf(userId: string) {
    return ProviderConnectionRepository.find({
      organizationId: acme,
      providerId: "acme-mail",
      userId,
    });
  }

  /** The access the person gave `app` to that connection. */
  function accessOf(userId: string, app: string) {
    return ProviderAppAccessRepository.find({
      organizationId: acme,
      providerId: "acme-mail",
      userId,
      appRowId: rows[app]!,
    });
  }

  /** Every access row, as `person app`, sorted. */
  async function accessRows(): Promise<string[]> {
    const slugs = Object.fromEntries(
      Object.entries(rows).map(([slug, rowId]) => [rowId, slug]),
    );
    return (await db.select().from(providerAppAccess))
      .map(
        (row) =>
          `${row.userId === owner ? "ben" : "pat"} ${slugs[row.appRowId] ?? row.appRowId}`,
      )
      .sort();
  }

  async function losesMail(userId: string) {
    await db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, userId),
          eq(userAppAccess.appRowId, rows["mail"]!),
        ),
      );
  }

  describe("connecting", () => {
    it("asks the provider for the scopes of every app in the organization and the spec's identity scopes, and stores one connection and the access of the app the connect started in", async () => {
      const started = await browse(
        "/connect/acme-mail?app=mail&return=https://mail.apps.example.com/",
      );
      const authorize = new URL(started!.headers.get("location")!);
      expect(authorize.origin + authorize.pathname).toBe(
        SPEC.auth.authorizeUrl,
      );
      const params = Object.fromEntries(authorize.searchParams);
      expect(params).toMatchObject({
        client_id: "acme-client-id",
        access_type: "offline",
        code_challenge_method: "S256",
      });
      // mail's scopes and notes's, each once, then the identity scope.
      expect(scopesAsked(authorize)).toEqual(
        [
          `${PREFIX}mail.read`,
          `${PREFIX}mail.send`,
          `${PREFIX}contacts.read`,
          "profile",
        ].sort(),
      );
      expect(params["include_granted_scopes"]).toBeUndefined();
      const back = provider.authorize(authorize);
      const finished = await browse(back.pathname + back.search);
      expect(finished?.status).toBe(302);
      expect(finished?.headers.get("location")).toBe(
        "https://mail.apps.example.com/",
      );
      // The client went on as HTTP Basic, as the spec says.
      expect(provider.state.tokenRequests[0]!.clientVia).toBe("basic");

      // One connection, the person's: it names no app.
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      const connection = await connectionOf(owner);
      expect(connection).toMatchObject({
        label: "inbox@acme.test",
        externalId: "7",
        status: "active",
      });
      expect([...connection!.scopes].sort()).toEqual([...HELD].sort());
      // One access row: the app the connect started in, for the scopes it lists.
      expect(await accessRows()).toEqual(["ben mail"]);
      expect(await accessOf(owner, "mail")).toMatchObject({
        scopes: ["mail.read", "mail.send"],
      });
      const listed = await listConnections({
        orgId: acme,
        userId: owner,
        role: "owner",
      } as never);
      expect(listed).toHaveLength(1);
      expect(listed[0]!.apps).toEqual([
        { rowId: rows["mail"], id: "mail", name: "mail" },
      ]);
      const [connected] = await eventsOf("provider.connected");
      expect(connected).toMatchObject({
        provider: { id: "acme-mail", name: "Acme Mail", kind: "oauth" },
        account: { user: { id: owner }, label: "inbox@acme.test" },
        app: { id: "mail", rowId: rows["mail"], name: "mail" },
        reconnected: false,
      });
      expect([...(connected!["scopes"] as string[])].sort()).toEqual(
        [...HELD].sort(),
      );
    });

    it("refuses a token carrying scopes beyond what the app asked, and keeps nothing (the mint check)", async () => {
      provider.state.grantExtra = [`${PREFIX}admin`];
      const finished = await connect("mail");
      expect(finished.status).toBe(400);
      const page = await finished.text();
      expect(page).toContain("admin");
      expect(page).toContain("nothing was kept");
      expect(page).not.toContain(provider.state.tokens[0]!.accessToken);
      expect(await db.select().from(providerConnections)).toEqual([]);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
      expect(await eventsOf("provider.connected")).toEqual([]);
    });

    it("sends a second app whose scopes the connection already holds to the Gateway's Allow page, never to the provider", async () => {
      await connect("mail");
      const started = await browse(
        "/connect/acme-mail?app=notes&return=https://notes.apps.example.com/",
      );
      expect(started?.status).toBe(302);
      const location = started!.headers.get("location")!;
      expect(location).toMatch(
        /^\/oauth\/app-access\?state=[A-Za-z0-9_-]{43}$/,
      );
      // A state the Allow page's form spends: it names the app, the person
      // and the scopes the app lists, and where to go afterwards.
      const states = await db.select().from(oauthStates);
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({
        state: new URLSearchParams(location.split("?")[1]).get("state"),
        purpose: "allow",
        providerId: "acme-mail",
        organizationId: acme,
        userId: owner,
        appRowId: rows["notes"],
        returnTo: "https://notes.apps.example.com/",
      });
      expect(JSON.parse(states[0]!.scopes)).toEqual([
        "mail.read",
        "contacts.read",
      ]);
      // Nothing is allowed until the person says so.
      expect(await accessRows()).toEqual(["ben mail"]);
    });

    it("sends an app the person already allowed, whose scopes are covered, straight back to return", async () => {
      await connect("mail");
      const again = await browse(
        "/connect/acme-mail?app=mail&return=https://mail.apps.example.com/inbox",
      );
      expect(again?.status).toBe(302);
      expect(again?.headers.get("location")).toBe(
        "https://mail.apps.example.com/inbox",
      );
      // Nothing to spend later, and nothing changed.
      expect(await db.select().from(oauthStates)).toEqual([]);
      expect(await accessRows()).toEqual(["ben mail"]);
    });

    it("sends an app that lists a scope the connection lacks to the provider, asking for every app's scopes again", async () => {
      await connect("mail");
      const first = (await connectionOf(owner))!;
      // Deployed later: it lists a scope no app listed at the connect.
      await deploy("calendar", ["calendar.read"]);
      const started = await browse("/connect/acme-mail?app=calendar");
      expect(started?.status).toBe(302);
      const authorize = new URL(started!.headers.get("location")!);
      expect(authorize.origin + authorize.pathname).toBe(
        SPEC.auth.authorizeUrl,
      );
      expect(scopesAsked(authorize)).toEqual(
        [
          `${PREFIX}calendar.read`,
          `${PREFIX}mail.read`,
          `${PREFIX}mail.send`,
          `${PREFIX}contacts.read`,
          "profile",
        ].sort(),
      );
      expect(await db.select().from(oauthStates)).toMatchObject([
        { purpose: "authorize", appRowId: rows["calendar"] },
      ]);
      const back = provider.authorize(authorize);
      const finished = await browse(back.pathname + back.search);
      expect(finished?.status).toBe(302);
      // The same connection, now holding the new scope; calendar is
      // allowed, and mail stays allowed (the same account).
      const connection = (await connectionOf(owner))!;
      expect(connection.id).toBe(first.id);
      expect(connection.scopes).toContain("calendar.read");
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      expect(await accessRows()).toEqual(["ben calendar", "ben mail"]);
    });

    it("takes every app's access away when the person connects another account, and allows the app the connect started in alone", async () => {
      await connect("mail");
      await allow("notes");
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      const first = (await connectionOf(owner))!;
      // The provider refused a refresh, so the next connect goes through it.
      await ProviderConnectionRepository.markExpired(first.id);
      const finished = await connect(
        "notes",
        asAccount({ email: "personal@acme.test", id: 8 }),
      );
      expect(finished.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        id: first.id,
        label: "personal@acme.test",
        externalId: "8",
        status: "active",
      });
      // mail was allowed the other account: it asks again.
      expect(await accessRows()).toEqual(["ben notes"]);
      const refused = await appCall("mail", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
    });

    it("keeps the other apps' access when the person connects the same account again", async () => {
      await connect("mail");
      await allow("notes");
      const first = (await connectionOf(owner))!;
      await ProviderConnectionRepository.markExpired(first.id);
      const finished = await connect("notes");
      expect(finished.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        id: first.id,
        externalId: "7",
        status: "active",
      });
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      const connected = await eventsOf("provider.connected");
      // The first connect, and the reconnect.
      expect(connected.map((event) => event["reconnected"]).sort()).toEqual([
        false,
        true,
      ]);
      // mail goes on working with the new token.
      const served = await appCall("mail", MESSAGES);
      expect(served.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)!.bearer).toBe(
        provider.state.tokens.at(-1)!.accessToken,
      );
    });

    it("asks the other apps again when the provider won't name the account this time", async () => {
      await connect("mail");
      await allow("notes");
      const first = (await connectionOf(owner))!;
      expect(first).toMatchObject({
        label: "inbox@acme.test",
        externalId: "7",
      });
      await ProviderConnectionRepository.markExpired(first.id);
      // The tokens are good, and the identity URL answers 503: nothing
      // says this is the account the apps were allowed.
      const finished = await connect("notes", unnamed);
      expect(finished.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        id: first.id,
        label: null,
        externalId: null,
        status: "active",
      });
      // notes, where the connect started, is allowed; mail asks again.
      expect(await accessRows()).toEqual(["ben notes"]);
      const upstreamCalls = provider.state.counters.api;
      const refused = await appCall("mail", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });

    it("asks the other apps again when the provider named the account neither at the earlier connect nor at this one", async () => {
      // The spec has an identity URL, and it answered 503 both times: two
      // unnamed accounts are not the same account for certain.
      expect((await connect("mail", unnamed)).status).toBe(302);
      const first = (await connectionOf(owner))!;
      expect(first).toMatchObject({ label: null, externalId: null });
      await allow("notes");
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);

      await ProviderConnectionRepository.markExpired(first.id);
      expect((await connect("notes", unnamed)).status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        id: first.id,
        label: null,
        externalId: null,
        status: "active",
      });
      // notes, where the connect started, is allowed; mail asks again.
      expect(await accessRows()).toEqual(["ben notes"]);
      const upstreamCalls = provider.state.counters.api;
      const refused = await appCall("mail", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });

    it("allows only the app a first connect started in, whatever access rows were left with no connection behind them", async () => {
      // A stray row: notes allowed to use a connection that isn't there.
      await ProviderAppAccessRepository.allow({
        organizationId: acme,
        providerId: "acme-mail",
        userId: owner,
        appRowId: rows["notes"]!,
        scopes: ["mail.read", "contacts.read"],
      });
      expect(await connectionOf(owner)).toBeNull();
      expect(await accessRows()).toEqual(["ben notes"]);

      const finished = await connect("mail");
      expect(finished.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({ status: "active" });
      // The stray row went with the connect: Ben never allowed notes this account.
      expect(await accessRows()).toEqual(["ben mail"]);
      const upstreamCalls = provider.state.counters.api;
      const refused = await appCall("notes", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        connectPath: "/connect/acme-mail?app=notes",
        reconnect: false,
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });

    it("keeps the other apps' access across a reconnect to a provider that names no account", async () => {
      // A provider whose spec has no identity URL: the Gateway never learns
      // which account a connection is to, the first time or any other.
      const FILES = {
        id: "acme-files",
        name: "Acme Files",
        description: "Files at Acme, as the person who connects.",
        docs: "https://console.acme-files.example/apps",
        hosts: ["api.acme-files.example"],
        auth: {
          kind: "oauth2-user",
          authorizeUrl: "https://auth.acme-files.example/authorize",
          tokenUrl: "https://auth.acme-files.example/token",
          clientId: "ACME_FILES_CLIENT_ID",
          clientSecret: "ACME_FILES_CLIENT_SECRET",
          inject: "basic",
          pkce: true,
          scopeSeparator: "space",
        },
      };
      const files = fakeOAuthProvider({
        authorizeUrl: FILES.auth.authorizeUrl,
        tokenUrl: FILES.auth.tokenUrl,
        apiHost: "api.acme-files.example",
        clientId: "files-client-id",
        clientSecret: "files-client-secret",
        scopeDialect: "space",
      });
      await addOAuthProvider(
        { orgId: acme, userId: owner, role: "owner" } as never,
        null,
        {
          spec: FILES,
          clientId: "files-client-id",
          clientSecret: "files-client-secret",
        },
      );
      resetGatewayProvidersForTests();
      await deploy("drive", ["files.read"], "acme-files");
      await deploy("backup", ["files.read", "files.write"], "acme-files");
      /** Connect Ben from inside `app`, through Acme Files. */
      const connectFiles = async (app: string) => {
        const started = await browse(`/connect/acme-files?app=${app}`);
        expect(started?.status).toBe(302);
        const back = files.authorize(started!.headers.get("location")!);
        return (await browse(back.pathname + back.search, files.fetch))!;
      };
      const connection = () =>
        ProviderConnectionRepository.find({
          organizationId: acme,
          providerId: "acme-files",
          userId: owner,
        });

      expect((await connectFiles("drive")).status).toBe(302);
      const first = (await connection())!;
      expect(first).toMatchObject({
        label: null,
        externalId: null,
        scopes: ["files.read", "files.write"],
      });
      await allow("backup", "acme-files");
      expect(await accessRows()).toEqual(["ben backup", "ben drive"]);

      // The provider refused a refresh; Ben connects again, from drive.
      await ProviderConnectionRepository.markExpired(first.id);
      expect((await connectFiles("drive")).status).toBe(302);
      expect(await connection()).toMatchObject({
        id: first.id,
        label: null,
        externalId: null,
        status: "active",
      });
      // No account was named before or now: backup stays allowed.
      expect(await accessRows()).toEqual(["ben backup", "ben drive"]);
      expect(files.state.counters.token).toBe(2);
    });

    it("stores the connection and allows nothing when the person lost the app between the start and the provider's answer", async () => {
      signIn(member, "pat@acme.test");
      const started = await browse(
        "/connect/acme-mail?app=mail&return=https://mail.apps.example.com/",
      );
      expect(started?.status).toBe(302);
      const back = provider.authorize(started!.headers.get("location")!);
      // While Pat is at the provider, their grant to mail is revoked.
      await losesMail(member);
      const finished = await browse(back.pathname + back.search);
      expect(finished?.status).toBe(302);
      // The connection is Pat's, and is kept; mail may not use it.
      expect(await connectionOf(member)).toMatchObject({
        label: "inbox@acme.test",
        externalId: "7",
        status: "active",
      });
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
      const upstreamCalls = provider.state.counters.api;
      const refused = await appCall("mail", MESSAGES, {
        user: null,
        headers: { "x-everyapp-user": member },
      });
      expect(refused.status).toBe(409);
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });

    it("stores the connection and allows nothing when the app stopped listing the provider between the start and the provider's answer", async () => {
      const started = await browse("/connect/acme-mail?app=notes");
      expect(started?.status).toBe(302);
      const back = provider.authorize(started!.headers.get("location")!);
      // While Ben is at the provider, notes is redeployed without it.
      await deploy("notes", null);
      const finished = await browse(back.pathname + back.search);
      expect(finished?.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        label: "inbox@acme.test",
        status: "active",
      });
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
      const refused = await appCall("notes", MESSAGES);
      expect(refused.status).toBe(403);
      expect(refused.headers.get("x-everyapp-error")).toBe(
        "capability_not_requested",
      );
      // mail, which lists the provider, is one Allow away: no second trip.
      await allow("mail");
      expect(await accessRows()).toEqual(["ben mail"]);
      expect(provider.state.counters.token).toBe(1);
    });
  });

  describe("the Allow page's form (POST /connect/<id>/allow)", () => {
    it("allows the app on approve and answers 303 to return; the state is spent", async () => {
      await connect("mail");
      const state = await allowState(
        "notes",
        "https://notes.apps.example.com/",
      );
      const tokenCalls = provider.state.counters.token;
      const answered = await decide(state, "approve");
      expect(answered?.status).toBe(303);
      expect(answered?.headers.get("location")).toBe(
        "https://notes.apps.example.com/",
      );
      expect(await accessOf(owner, "notes")).toMatchObject({
        scopes: ["mail.read", "contacts.read"],
      });
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      // No provider was asked, and the one connection is as it was.
      expect(provider.state.counters.token).toBe(tokenCalls);
      expect(await db.select().from(providerConnections)).toHaveLength(1);
      // The same form again is refused.
      expect(await db.select().from(oauthStates)).toEqual([]);
      const replay = await decide(state, "approve");
      expect(replay?.status).toBe(400);
      expect(await replay?.text()).toContain("used already");
    });

    it("writes nothing on deny and answers 303 to return; the state is spent", async () => {
      await connect("mail");
      const state = await allowState(
        "notes",
        "https://notes.apps.example.com/",
      );
      const answered = await decide(state, "deny");
      expect(answered?.status).toBe(303);
      expect(answered?.headers.get("location")).toBe(
        "https://notes.apps.example.com/",
      );
      expect(await accessOf(owner, "notes")).toBeNull();
      // A change of mind needs a new page: the state went with the answer.
      const replay = await decide(state, "approve");
      expect(replay?.status).toBe(400);
      expect(await replay?.text()).toContain("used already");
      expect(await accessRows()).toEqual(["ben mail"]);
    });

    it("refuses a state the provider's callback is to spend, and the callback refuses the Allow page's; each is spent all the same", async () => {
      // An authorize state, posted to the form: nothing is allowed.
      const started = await browse("/connect/acme-mail?app=mail");
      const back = provider.authorize(started!.headers.get("location")!);
      const authorizeState = back.searchParams.get("state")!;
      const posted = await decide(authorizeState, "approve");
      expect(posted?.status).toBe(400);
      expect(await db.select().from(providerAppAccess)).toEqual([]);
      // It is spent: the provider's own callback with it is refused too.
      const late = await browse(back.pathname + back.search);
      expect(late?.status).toBe(400);
      expect(await late?.text()).toContain("used already");
      expect(provider.state.counters.token).toBe(0);
      expect(await db.select().from(providerConnections)).toEqual([]);

      // An allow state, sent to the callback with a code: nothing exchanged.
      await connect("mail");
      const tokenCalls = provider.state.counters.token;
      const allowing = await allowState("notes");
      const forged = await browse(
        `/connect/acme-mail/callback?code=a-code&state=${allowing}`,
      );
      expect(forged?.status).toBe(400);
      expect(provider.state.counters.token).toBe(tokenCalls);
      // It is spent: the form with it is refused, and notes isn't allowed.
      const after = await decide(allowing, "approve");
      expect(after?.status).toBe(400);
      expect(await accessRows()).toEqual(["ben mail"]);
    });

    it("refuses another person's state, and spends it", async () => {
      await connect("mail");
      const state = await allowState("notes");
      signIn(member, "pat@acme.test");
      const foreign = await decide(state, "approve");
      expect(foreign?.status).toBe(400);
      expect(await foreign?.text()).toContain("started by someone else");
      signIn(owner, "ben@acme.test");
      const mine = await decide(state, "approve");
      expect(mine?.status).toBe(400);
      expect(await accessRows()).toEqual(["ben mail"]);
    });

    it("refuses when the connection was never asked for what the app lists, or expired", async () => {
      await connect("mail");
      const state = await allowState(
        "notes",
        "https://notes.apps.example.com/",
      );
      // Replaced meanwhile by a connection the provider was never asked
      // `contacts.read` for. (One the person un-ticked it on is theirs to
      // allow: flow.sqlite.test.ts.)
      const less = JSON.stringify(["mail.read", "mail.send", "profile"]);
      await db
        .update(providerConnections)
        .set({ scopes: less, askedScopes: less })
        .where(eq(providerConnections.userId, owner));
      const answered = await decide(state, "approve");
      expect(answered?.status).toBe(409);
      expect(answered?.headers.get("location")).toBeNull();
      expect(await answered?.text()).toContain("connection changed");
      expect(await accessOf(owner, "notes")).toBeNull();

      // Expired meanwhile: the same.
      await db
        .update(providerConnections)
        .set({ scopes: JSON.stringify(HELD) })
        .where(eq(providerConnections.userId, owner));
      const second = await allowState("notes");
      await ProviderConnectionRepository.markExpired(
        (await connectionOf(owner))!.id,
      );
      expect((await decide(second, "approve"))?.status).toBe(409);
      expect(await accessOf(owner, "notes")).toBeNull();
    });

    it("refuses when the app lists more by now than the page showed, though the connection holds it, and a fresh page allows it for all of it", async () => {
      await connect("mail");
      // The page Ben has open shows what notes lists now.
      const state = await allowState(
        "notes",
        "https://notes.apps.example.com/",
      );
      const [shown] = await db.select().from(oauthStates);
      expect(JSON.parse(shown!.scopes)).toEqual(["mail.read", "contacts.read"]);
      // notes is redeployed listing `mail.send` too, which Ben's connection
      // holds already (mail lists it).
      await deploy("notes", ["mail.read", "contacts.read", "mail.send"]);
      expect((await connectionOf(owner))!.scopes).toContain("mail.send");

      const answered = await decide(state, "approve");
      expect(answered?.status).toBe(409);
      expect(answered?.headers.get("location")).toBeNull();
      expect(await answered?.text()).toContain(
        "asks for more than this page showed",
      );
      // Ben said yes to two scopes, not three: nothing is written.
      expect(await accessOf(owner, "notes")).toBeNull();
      expect(await accessRows()).toEqual(["ben mail"]);
      // The state is spent all the same.
      expect(await db.select().from(oauthStates)).toEqual([]);
      const replay = await decide(state, "approve");
      expect(replay?.status).toBe(400);
      expect(await replay?.text()).toContain("used already");

      // Opening notes again leads to a new page, for what it lists now.
      const fresh = await allowState(
        "notes",
        "https://notes.apps.example.com/",
      );
      expect(fresh).not.toBe(state);
      const [reshown] = await db.select().from(oauthStates);
      expect(JSON.parse(reshown!.scopes)).toEqual([
        "mail.read",
        "contacts.read",
        "mail.send",
      ]);
      const allowed = await decide(fresh, "approve");
      expect(allowed?.status).toBe(303);
      expect(allowed?.headers.get("location")).toBe(
        "https://notes.apps.example.com/",
      );
      expect(await accessOf(owner, "notes")).toMatchObject({
        scopes: ["mail.read", "contacts.read", "mail.send"],
      });
      // No provider was asked for any of it.
      expect(provider.state.counters.token).toBe(1);
    });

    it("spends an Allow page left open when the person connects another account: its form allows nothing", async () => {
      await connect("mail");
      const first = (await connectionOf(owner))!;
      // A page for notes, open in another tab: it shows inbox@acme.test.
      const open = await allowState("notes");
      expect(await db.select().from(oauthStates)).toMatchObject([
        { state: open, purpose: "allow", appRowId: rows["notes"] },
      ]);
      // The provider refused a refresh; Ben connects again from mail, and
      // picks a personal account this time.
      await ProviderConnectionRepository.markExpired(first.id);
      const finished = await connect(
        "mail",
        asAccount({ email: "personal@acme.test", id: 8 }),
      );
      expect(finished.status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({
        id: first.id,
        label: "personal@acme.test",
        externalId: "8",
        status: "active",
      });
      // The open page's state went with the connect.
      expect(await db.select().from(oauthStates)).toEqual([]);

      // The old form, posted now: the new account holds what notes lists,
      // and notes still isn't allowed it.
      expect((await connectionOf(owner))!.scopes).toEqual(
        expect.arrayContaining(["mail.read", "contacts.read"]),
      );
      const posted = await decide(open, "approve");
      expect(posted?.status).toBe(400);
      expect(await posted?.text()).toContain("used already");
      expect(await accessOf(owner, "notes")).toBeNull();
      expect(await accessRows()).toEqual(["ben mail"]);
      const upstreamCalls = provider.state.counters.api;
      expect((await appCall("notes", MESSAGES)).status).toBe(409);
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });

    it("spends an Allow page left open on any connect, the same account's too, and leaves another person's page alone", async () => {
      // Pat opens notes too, connects, and leaves a page for notes open.
      await db.insert(userAppAccess).values({
        id: "grant-pat-notes",
        organizationId: acme,
        userId: member,
        appRowId: rows["notes"]!,
      });
      signIn(member, "pat@acme.test");
      await connect("mail");
      const pats = await allowState("notes");
      // So does Ben.
      signIn(owner, "ben@acme.test");
      await connect("mail");
      const bens = await allowState("notes");

      // Ben connects the same account again.
      await ProviderConnectionRepository.markExpired(
        (await connectionOf(owner))!.id,
      );
      expect((await connect("mail")).status).toBe(302);
      expect(await connectionOf(owner)).toMatchObject({ externalId: "7" });
      // Ben's page is spent; a new one allows notes.
      const posted = await decide(bens, "approve");
      expect(posted?.status).toBe(400);
      expect(await accessOf(owner, "notes")).toBeNull();
      await allow("notes");
      expect(await accessOf(owner, "notes")).not.toBeNull();

      // Pat's page was Pat's connection's: it still works.
      signIn(member, "pat@acme.test");
      expect((await decide(pats, "approve"))?.status).toBe(303);
      expect(await accessRows()).toEqual([
        "ben mail",
        "ben notes",
        "pat mail",
        "pat notes",
      ]);
    });

    it("refuses when the person no longer opens the app, or the app no longer lists the provider", async () => {
      // Pat opens mail and notes, connects in mail, and is asked about notes.
      await db.insert(userAppAccess).values({
        id: "grant-pat-notes",
        organizationId: acme,
        userId: member,
        appRowId: rows["notes"]!,
      });
      signIn(member, "pat@acme.test");
      await connect("mail");
      const state = await allowState("notes");
      await db
        .delete(userAppAccess)
        .where(eq(userAppAccess.id, "grant-pat-notes"));
      const closed = await decide(state, "approve");
      expect(closed?.status).toBe(404);
      expect(await accessOf(member, "notes")).toBeNull();

      // Ben is asked about notes, and notes is redeployed without the provider.
      signIn(owner, "ben@acme.test");
      await connect("mail");
      const second = await allowState("notes");
      await deploy("notes", null);
      const unlisted = await decide(second, "approve");
      expect(unlisted?.status).toBe(404);
      expect(await accessOf(owner, "notes")).toBeNull();
    });

    it("answers 405 to a GET, and a signed-out POST with a page that allows nothing", async () => {
      const got = await browse("/connect/acme-mail/allow?state=x");
      expect(got?.status).toBe(405);
      expect(got?.headers.get("allow")).toBe("POST");
      // The start and the callback take no POST.
      for (const path of [
        "/connect/acme-mail",
        "/connect/acme-mail/callback",
      ]) {
        const posted = await serveConnectRoute(
          new Request(`${GATEWAY}${path}`, { method: "POST" }),
        );
        expect(posted?.status, path).toBe(405);
      }
      await connect("mail");
      const state = await allowState("notes");
      session.current = null;
      const signedOut = await decide(state, "approve");
      expect(signedOut?.status).toBe(401);
      expect(await accessRows()).toEqual(["ben mail"]);
    });
  });

  describe("an app's call with the held token", () => {
    it("puts the person's token on calls to the spec's hosts alone, and reports the connection", async () => {
      await connect("mail");
      const token = provider.state.tokens[0]!.accessToken;
      const status = await appCall("mail", "/api/integrations/acme-mail");
      await expect(status.json()).resolves.toEqual({
        capability: "acme-mail",
        requested: true,
        configured: true,
        ready: true,
        scopes: ["mail.read", "mail.send"],
        connectPath: "/connect/acme-mail?app=mail",
        connection: { label: "inbox@acme.test", scopes: HELD, ready: true },
        settings: [],
        setup: null,
        command: null,
      });
      const sent = await appCall(
        "mail",
        "/api/integrations/acme-mail/api.acme-mail.example/v1/send",
        { method: "POST" },
      );
      expect(sent.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)).toMatchObject({
        method: "POST",
        url: "https://api.acme-mail.example/v1/send",
        bearer: token,
      });
      // The token endpoint and any other host never get it.
      for (const host of ["auth.acme-mail.example", "evil.example"]) {
        const refused = await appCall(
          "mail",
          `/api/integrations/acme-mail/${host}/token`,
        );
        expect(refused.status).toBe(400);
        expect(refused.headers.get("x-everyapp-error")).toBe(
          "invalid_integration_route",
        );
      }
      // An app that doesn't list the provider is refused first.
      const other = await appCall("other", MESSAGES);
      expect(other.status).toBe(403);
      expect(other.headers.get("x-everyapp-error")).toBe(
        "capability_not_requested",
      );
      // One `connection.used` a day, however many calls.
      await appCall("mail", MESSAGES);
      const used = await eventsOf("connection.used");
      expect(used).toHaveLength(1);
      expect(used[0]).toMatchObject({
        connection: { kind: "oauth", clientName: "Acme Mail" },
        app: { id: "mail" },
        user: { id: owner },
      });
    });

    it("refuses a call from an app the person hasn't allowed", async () => {
      await connect("mail");
      // Ben's connection holds every scope notes lists; notes has no access row.
      expect((await connectionOf(owner))!.scopes).toEqual(
        expect.arrayContaining(["mail.read", "contacts.read"]),
      );
      expect(await accessOf(owner, "notes")).toBeNull();
      const upstreamCalls = provider.state.counters.api;

      const refused = await appCall("notes", MESSAGES);
      expect(refused.status).toBe(409);
      expect(refused.headers.get("x-everyapp-error")).toBe(
        "integration_not_connected",
      );
      const body = await refused.text();
      expect(JSON.parse(body)).toMatchObject({
        code: "integration_not_connected",
        connectPath: "/connect/acme-mail?app=notes",
        reconnect: false,
      });
      expect(body).not.toContain(provider.state.tokens[0]!.accessToken);
      // In the background, naming Ben, as well.
      const unattended = await appCall("notes", MESSAGES, {
        user: null,
        headers: { "x-everyapp-user": owner },
      });
      expect(unattended.status).toBe(409);
      await expect(unattended.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
      // Nothing reached the provider, and the connection is untouched.
      expect(provider.state.counters.api).toBe(upstreamCalls);
      expect(await connectionOf(owner)).toMatchObject({
        status: "active",
        lastUsedAt: null,
      });
    });

    it("serves an app the person allowed on the Allow page with their token", async () => {
      await connect("mail");
      await allow("notes");
      const token = provider.state.tokens[0]!.accessToken;
      const served = await appCall("notes", MESSAGES);
      expect(served.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)).toMatchObject({
        url: "https://api.acme-mail.example/v1/messages",
        bearer: token,
      });
      // The one connection serves both apps.
      const mail = await appCall("mail", MESSAGES);
      expect(mail.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)!.bearer).toBe(token);
      expect(await db.select().from(providerConnections)).toHaveLength(1);
    });

    it("reports no connection to an app the person hasn't allowed, and a ready one once they have", async () => {
      await connect("mail");
      const before = await appCall("notes", "/api/integrations/acme-mail");
      await expect(before.json()).resolves.toMatchObject({
        requested: true,
        configured: true,
        ready: false,
        scopes: ["mail.read", "contacts.read"],
        connectPath: "/connect/acme-mail?app=notes",
        connection: null,
      });
      await allow("notes");
      const after = await appCall("notes", "/api/integrations/acme-mail");
      await expect(after.json()).resolves.toMatchObject({
        ready: true,
        connectPath: "/connect/acme-mail?app=notes",
        connection: { label: "inbox@acme.test", scopes: HELD, ready: true },
      });
    });

    it("asks the person again when the app lists more than they allowed it, naming the scopes", async () => {
      await connect("mail");
      // Allowed while mail listed `mail.read` alone; it lists `mail.send` now.
      await ProviderAppAccessRepository.allow({
        organizationId: acme,
        providerId: "acme-mail",
        userId: owner,
        appRowId: rows["mail"]!,
        scopes: ["mail.read"],
      });
      const upstreamCalls = provider.state.counters.api;
      const refused = await appCall("mail", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        connectPath: "/connect/acme-mail?app=mail",
        reconnect: true,
        missingScopes: ["mail.send"],
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
      const status = await appCall("mail", "/api/integrations/acme-mail");
      await expect(status.json()).resolves.toMatchObject({
        ready: false,
        connection: {
          ready: false,
          reconnect: true,
          missingScopes: ["mail.send"],
        },
      });
      // The connection holds `mail.send`, so the Allow page settles it.
      await allow("mail");
      expect(await accessOf(owner, "mail")).toMatchObject({
        scopes: ["mail.read", "mail.send"],
      });
      expect((await appCall("mail", MESSAGES)).status).toBe(200);
    });

    it("lets an organization's own app use another member's connection by naming them, even while serving someone else", async () => {
      signIn(member, "pat@acme.test");
      await connect("mail");
      const patToken = provider.state.tokens[0]!.accessToken;
      // Ben is behind the call; the app names Pat's connection.
      const forPat = await appCall("mail", MESSAGES, {
        headers: { "x-everyapp-user": member },
      });
      expect(forPat.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)!.bearer).toBe(patToken);
      expect(
        provider.state.apiRequests.at(-1)!.headers["x-everyapp-user"],
      ).toBeUndefined();
      // Background work with nobody behind it names Pat the same way.
      const alone = await appCall("mail", MESSAGES, {
        user: null,
        headers: { "x-everyapp-user": member },
      });
      expect(alone.status).toBe(200);
      // Nobody behind it and nobody named: no connection to use.
      const nobody = await appCall("mail", MESSAGES, { user: null });
      expect(nobody.status).toBe(409);
      await expect(nobody.json()).resolves.toMatchObject({ reconnect: false });
      const malformed = await appCall("mail", MESSAGES, {
        headers: { "x-everyapp-user": "pat; drop table" },
      });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("x-everyapp-error")).toBe(
        "integration_body_invalid",
      );
      // Linked dev never names a member.
      const dev = await appCall("mail", MESSAGES, {
        headers: { "x-everyapp-user": member },
        trusted: {
          organizationId: acme,
          user: {
            id: owner,
            email: "ben@acme.test",
            orgId: acme,
            orgRole: "owner",
            channel: "browser",
            actor: owner,
            scopes: ["*"],
          } as unknown as EveryAppUser,
        },
      });
      expect(dev.status).toBe(403);
      expect(dev.headers.get("x-everyapp-error")).toBe(
        "integration_user_not_allowed",
      );
    });

    it("takes the app's access away, and keeps the connection, when the member an app names lost the app", async () => {
      // Pat opens notes too, and allowed both apps.
      await db.insert(userAppAccess).values({
        id: "grant-pat-notes",
        organizationId: acme,
        userId: member,
        appRowId: rows["notes"]!,
      });
      signIn(member, "pat@acme.test");
      await connect("mail");
      await allow("notes");
      const patToken = provider.state.tokens[0]!.accessToken;
      expect(await accessRows()).toEqual(["pat mail", "pat notes"]);

      await losesMail(member);
      expect(
        await memberMayUseApp({
          organizationId: acme,
          userId: member,
          appRowId: rows["mail"]!,
        }),
      ).toBe(false);
      const upstreamCalls = provider.state.counters.api;
      const lost = await appCall("mail", MESSAGES, {
        headers: { "x-everyapp-user": member },
      });
      expect(lost.status).toBe(409);
      await expect(lost.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
      // mail's access to Pat's connection is gone; the connection and
      // notes's access stay, and notes goes on using it.
      expect(await accessRows()).toEqual(["pat notes"]);
      expect(await connectionOf(member)).toMatchObject({ status: "active" });
      const notes = await appCall("notes", MESSAGES, {
        user: null,
        headers: { "x-everyapp-user": member },
      });
      expect(notes.status).toBe(200);
      expect(provider.state.apiRequests.at(-1)!.bearer).toBe(patToken);
    });

    it("refuses to name a member from a shared app", async () => {
      const lookup: CapabilityLookup = {
        get: (id) => (id === "acme-mail" ? specCapability : CATALOG.get(id)),
        ids: () => [...CATALOG.ids(), "acme-mail"],
      };
      const find = vi.fn(async () => null);
      const allowedScopes = vi.fn(async () => null);
      const response = await handleIntegrationProxyRequest({
        request: new Request(
          "http://every-app-gateway.internal/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
          { headers: { "x-everyapp-user": "user-9" } },
        ),
        capabilities: {
          "acme-mail": { scopes: ["mail.read"], why: "Reads mail." },
        } as never,
        lookup,
        env: {},
        admit: async () => ({
          caller: {
            organizationId: "org-b",
            appId: "mail",
            worker: "every-platform-mail",
            orgSource: "jwt",
          },
          user: null,
        }),
        listMembers: async () => [],
        oauth: {
          resolveClient: async () => ({
            clientId: "id",
            source: OAuthClientSource.Env,
          }),
          connections: {
            find,
            allowedScopes,
            accessToken: async () => ({
              ok: true,
              accessToken: "t",
              version: 0,
            }),
            expired: async () => undefined,
            used: async () => undefined,
          },
          app: {
            rowId: "app-shared-mail",
            appId: "mail",
            scope: "shared",
            tier: "service_binding",
            organizationId: "org-platform",
          },
          members: {
            mayUse: async () => true,
            revoke: async () => undefined,
          },
          identify: async () => null,
        },
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("x-everyapp-error")).toBe(
        "integration_user_not_allowed",
      );
      expect(find).not.toHaveBeenCalled();
      expect(allowedScopes).not.toHaveBeenCalled();
    });

    it("marks a connection expired when a refresh comes back with scopes beyond the connection's, and drops those tokens", async () => {
      await connect("mail");
      const issued = { ...provider.state.tokens[0]! };
      const connection = (await connectionOf(owner))!;
      await ProviderConnectionRepository.storeTokens(
        connection.id,
        {
          accessToken: issued.accessToken,
          refreshToken: issued.refreshToken,
          expiresAt: Date.now() + 10_000,
        },
        fakeEnv,
      );
      provider.state.grantExtra = [`${PREFIX}admin`];
      const refused = await appCall("mail", MESSAGES);
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: true,
      });
      expect(provider.state.counters.refresh).toBe(1);
      expect(await connectionOf(owner)).toMatchObject({
        status: "expired",
        scopes: HELD,
      });
      // The refreshed token was never stored.
      const stored = await ProviderConnectionRepository.readTokens(
        connection.id,
        fakeEnv,
      );
      expect(stored?.accessToken).toBe(issued.accessToken);
      // The event names the app whose call met the refusal.
      const expired = await eventsOf("provider.connection_expired");
      expect(expired).toHaveLength(1);
      expect(expired[0]).toMatchObject({ app: { id: "mail" } });
    });
  });

  describe("the lifecycle", () => {
    /** Ben allowed mail and notes; Pat allowed mail. */
    beforeEach(async () => {
      await connect("mail");
      await allow("notes");
      signIn(member, "pat@acme.test");
      await connect("mail");
      expect(await db.select().from(providerConnections)).toHaveLength(2);
      expect(await accessRows()).toEqual(["ben mail", "ben notes", "pat mail"]);
    });

    it("takes the app's access away, and keeps the connection, when a member loses the app", async () => {
      // Pat's direct grant goes: mail's access to Pat's connection goes with it.
      await losesMail(member);
      expect(await ProviderAppAccessRepository.pruneWithoutAccess(acme)).toBe(
        1,
      );
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      expect(await connectionOf(member)).toMatchObject({ status: "active" });
      expect(await db.select().from(providerConnections)).toHaveLength(2);
    });

    it("deletes an app's access rows with the app, and keeps the connections", async () => {
      const app = await AppRepository.findById(rows["mail"]!, acme);
      await AppRepository.tombstone(app!);
      // mail's access is gone for everyone; notes's stays.
      expect(await accessRows()).toEqual(["ben notes"]);
      // The connections are the people's: both stay, tokens and all.
      expect(await db.select().from(providerConnections)).toHaveLength(2);
      expect(await connectionOf(owner)).toMatchObject({ status: "active" });
      expect(await connectionOf(member)).toMatchObject({ status: "active" });
      // notes goes on using Ben's.
      signIn(owner, "ben@acme.test");
      expect((await appCall("notes", MESSAGES)).status).toBe(200);
    });

    it("drops the connection and every app's access to it when the member leaves the organization", async () => {
      expect(
        await OrganizationMembersRepository.removeMember(member, acme),
      ).toBe(true);
      expect(await connectionOf(member)).toBeNull();
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      expect(await connectionOf(owner)).not.toBeNull();
    });

    it("drops the connection and every app's access to it when the member is deactivated", async () => {
      expect(await UserRepository.deactivate(member, "test")).toBe(true);
      expect(await connectionOf(member)).toBeNull();
      expect(await accessRows()).toEqual(["ben mail", "ben notes"]);
      expect(await connectionOf(owner)).not.toBeNull();
    });

    it("asks again before an app a member allowed earlier uses the account they connect after being deactivated and coming back", async () => {
      expect(await UserRepository.deactivate(member, "test")).toBe(true);
      await UserRepository.reactivate(member);
      // Back, Pat opens notes too, and connects a personal account from inside it.
      await db.insert(userAppAccess).values({
        id: "grant-pat-notes",
        organizationId: acme,
        userId: member,
        appRowId: rows["notes"]!,
      });
      const finished = await connect(
        "notes",
        asAccount({ email: "pat-personal@acme.test", id: 9 }),
      );
      expect(finished.status).toBe(302);
      expect(await connectionOf(member)).toMatchObject({
        label: "pat-personal@acme.test",
        externalId: "9",
      });
      // mail was allowed the account Pat had before: it gets nothing of
      // this one until Pat allows it.
      const upstreamCalls = provider.state.counters.api;
      const mail = await appCall("mail", MESSAGES, { user: member });
      expect(mail.status).toBe(409);
      await expect(mail.json()).resolves.toMatchObject({
        code: "integration_not_connected",
        reconnect: false,
      });
      expect(provider.state.counters.api).toBe(upstreamCalls);
    });
  });
});
