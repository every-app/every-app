/**
 * One OAuth provider driven only by its spec (docs/design/2026-11-oauth-simplify.md),
 * end to end against a migrated SQLite database and the fake provider:
 * nothing here names Google, GitHub or any other provider. A connect asks
 * for exactly the app's scopes plus the spec's identity scopes; the
 * callback stores the connection as this person's in this app; a token
 * carrying more than was asked is refused at mint and at refresh; the
 * proxy puts the token on calls to the spec's hosts alone; an
 * organization's own app may use another member's connection to it by
 * naming them, a shared app and linked dev may not; and the lifecycle
 * drops connections with the member, their access and the app.
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
  parseProviderSpec,
  type CapabilityLookup,
  type EveryAppUser,
  type OAuthClientCapability,
} from "@every-app/sdk/internal";
import { and, eq } from "drizzle-orm";
import { events, providerConnections, userAppAccess } from "@/db/schema";
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
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { fakeOAuthProvider } from "@/test/fake-oauth-provider";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { memberMayUseApp } from "./appAccess";
import { resolveOAuthClient } from "./client";
import { serveConnectRoute } from "./flow";
import { gatewayHeldTokens } from "./heldTokens";
import { addOAuthProvider, listConnections } from "./service";

const GATEWAY = "https://home.example.com";
const PREFIX = "https://acme-mail.example/scopes/";
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
    for (const [appSlug, capabilities] of [
      [
        "mail",
        {
          "acme-mail": {
            scopes: ["mail.read", "mail.send"],
            why: "Mirrors your mail and sends when you press Send.",
          },
        },
      ],
      [
        "notes",
        {
          "acme-mail": {
            scopes: ["mail.read"],
            why: "Files mail into notes.",
          },
        },
      ],
      ["other", {}],
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

  function browse(path: string) {
    return serveConnectRoute(new Request(`${GATEWAY}${path}`), {
      fetchUpstream: provider.fetch,
      now: () => now,
    });
  }

  /** Connect the signed-in person in `app`; the final redirect. */
  async function connect(app: string): Promise<Response> {
    const started = await browse(`/connect/acme-mail?app=${app}`);
    expect(started?.status).toBe(302);
    const back = provider.authorize(started!.headers.get("location")!);
    return (await browse(back.pathname + back.search))!;
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

  async function connectionOf(userId: string, app: string) {
    return ProviderConnectionRepository.find({
      organizationId: acme,
      providerId: "acme-mail",
      userId,
      appRowId: rows[app]!,
    });
  }

  it("asks for exactly the app's scopes and the spec's identity scopes, and stores the connection as this person's in this app", async () => {
    const started = await browse(
      "/connect/acme-mail?app=mail&return=https://mail.apps.example.com/",
    );
    const authorize = new URL(started!.headers.get("location")!);
    const params = Object.fromEntries(authorize.searchParams);
    expect(params).toMatchObject({
      client_id: "acme-client-id",
      access_type: "offline",
      code_challenge_method: "S256",
      scope: `${PREFIX}mail.read ${PREFIX}mail.send profile`,
    });
    expect(params["include_granted_scopes"]).toBeUndefined();
    const back = provider.authorize(authorize);
    const finished = await browse(back.pathname + back.search);
    expect(finished?.status).toBe(302);
    expect(finished?.headers.get("location")).toBe(
      "https://mail.apps.example.com/",
    );
    // The client went on as HTTP Basic, as the spec says.
    expect(provider.state.tokenRequests[0]!.clientVia).toBe("basic");
    expect(await connectionOf(owner, "mail")).toMatchObject({
      label: "inbox@acme.test",
      externalId: "7",
      scopes: ["mail.read", "mail.send", "profile"],
      status: "active",
    });
    // The same person in another app is another connection, for its scopes.
    await connect("notes");
    const started2 = provider.state.authorizeRequests.at(-1)!;
    expect(started2.scope).toBe(`${PREFIX}mail.read profile`);
    expect(await connectionOf(owner, "notes")).toMatchObject({
      scopes: ["mail.read", "profile"],
    });
    const listed = await listConnections({
      orgId: acme,
      userId: owner,
      role: "owner",
    } as never);
    expect(listed.map((each) => each.app.id).sort()).toEqual(["mail", "notes"]);
    const [connected] = await eventsOf("provider.connected");
    expect(connected).toMatchObject({
      provider: { id: "acme-mail", name: "Acme Mail", kind: "oauth" },
      account: { user: { id: owner }, label: "inbox@acme.test" },
      app: { id: "mail", rowId: rows["mail"], name: "mail" },
      scopes: ["mail.read", "mail.send", "profile"],
      reconnected: false,
    });
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
    expect(await eventsOf("provider.connected")).toEqual([]);
  });

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
      connection: {
        label: "inbox@acme.test",
        scopes: ["mail.read", "mail.send", "profile"],
        ready: true,
      },
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
    // notes has no connection of Ben's: mail's is mail's alone.
    const notes = await appCall(
      "notes",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
    );
    expect(notes.status).toBe(409);
    await expect(notes.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      connectPath: "/connect/acme-mail?app=notes",
      reconnect: false,
    });
    const notesStatus = await appCall("notes", "/api/integrations/acme-mail");
    await expect(notesStatus.json()).resolves.toMatchObject({
      ready: false,
      connection: null,
    });
    // An app that doesn't list the provider is refused first.
    const other = await appCall(
      "other",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
    );
    expect(other.status).toBe(403);
    expect(other.headers.get("x-everyapp-error")).toBe(
      "capability_not_requested",
    );
    // One `connection.used` a day, however many calls.
    await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
    );
    const used = await eventsOf("connection.used");
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({
      connection: { kind: "oauth", clientName: "Acme Mail" },
      app: { id: "mail" },
      user: { id: owner },
    });
  });

  it("lets an organization's own app use another member's connection by naming them, even while serving someone else", async () => {
    signIn(member, "pat@acme.test");
    await connect("mail");
    const patToken = provider.state.tokens[0]!.accessToken;
    // Ben is behind the call; the app names Pat's connection.
    const forPat = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      { headers: { "x-everyapp-user": member } },
    );
    expect(forPat.status).toBe(200);
    expect(provider.state.apiRequests.at(-1)!.bearer).toBe(patToken);
    expect(
      provider.state.apiRequests.at(-1)!.headers["x-everyapp-user"],
    ).toBeUndefined();
    // Background work with nobody behind it names Pat the same way.
    const alone = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      { user: null, headers: { "x-everyapp-user": member } },
    );
    expect(alone.status).toBe(200);
    // Nobody behind it and nobody named: no connection to use.
    const nobody = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      { user: null },
    );
    expect(nobody.status).toBe(409);
    await expect(nobody.json()).resolves.toMatchObject({ reconnect: false });
    const malformed = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      { headers: { "x-everyapp-user": "pat; drop table" } },
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("x-everyapp-error")).toBe(
      "integration_body_invalid",
    );
    // Linked dev never names a member.
    const dev = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      {
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
      },
    );
    expect(dev.status).toBe(403);
    expect(dev.headers.get("x-everyapp-error")).toBe(
      "integration_user_not_allowed",
    );

    // Pat loses the app: the next call naming Pat drops Pat's connection.
    await db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, member),
          eq(userAppAccess.appRowId, rows["mail"]!),
        ),
      );
    expect(
      await memberMayUseApp({
        organizationId: acme,
        userId: member,
        appRowId: rows["mail"]!,
      }),
    ).toBe(false);
    const lost = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
      { headers: { "x-everyapp-user": member } },
    );
    expect(lost.status).toBe(409);
    expect(await connectionOf(member, "mail")).toBeNull();
  });

  it("refuses to name a member from a shared app", async () => {
    const lookup: CapabilityLookup = {
      get: (id) => (id === "acme-mail" ? specCapability : CATALOG.get(id)),
      ids: () => [...CATALOG.ids(), "acme-mail"],
    };
    const find = vi.fn(async () => null);
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
        resolveClient: async () => ({ clientId: "id", source: "env" }),
        connections: {
          find,
          accessToken: async () => ({ ok: true, accessToken: "t" }),
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
  });

  it("marks a connection expired when a refresh comes back with scopes beyond the connection's, and drops those tokens", async () => {
    await connect("mail");
    const issued = { ...provider.state.tokens[0]! };
    const connection = (await connectionOf(owner, "mail"))!;
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
    const refused = await appCall(
      "mail",
      "/api/integrations/acme-mail/api.acme-mail.example/v1/messages",
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: "integration_not_connected",
      reconnect: true,
    });
    expect(provider.state.counters.refresh).toBe(1);
    expect(await connectionOf(owner, "mail")).toMatchObject({
      status: "expired",
      scopes: ["mail.read", "mail.send", "profile"],
    });
    // The refreshed token was never stored.
    const stored = await ProviderConnectionRepository.readTokens(
      connection.id,
      fakeEnv,
    );
    expect(stored?.accessToken).toBe(issued.accessToken);
    expect(await eventsOf("provider.connection_expired")).toHaveLength(1);
  });

  it("drops connections when the member loses the app, leaves, or the app is deleted", async () => {
    await connect("mail");
    signIn(member, "pat@acme.test");
    await connect("mail");
    expect(await db.select().from(providerConnections)).toHaveLength(2);

    // Pat's direct grant goes: Pat's connection in mail goes with it.
    await db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.userId, member),
          eq(userAppAccess.appRowId, rows["mail"]!),
        ),
      );
    expect(await ProviderConnectionRepository.pruneWithoutAccess(acme)).toBe(1);
    expect(await connectionOf(member, "mail")).toBeNull();
    expect(await connectionOf(owner, "mail")).not.toBeNull();

    // Pat connects again, then leaves the organization.
    await db.insert(userAppAccess).values({
      id: "grant-pat-mail-2",
      organizationId: acme,
      userId: member,
      appRowId: rows["mail"]!,
    });
    await connect("mail");
    expect(await OrganizationMembersRepository.removeMember(member, acme)).toBe(
      true,
    );
    expect(await connectionOf(member, "mail")).toBeNull();

    // The app is deleted: every connection in it goes.
    const app = await AppRepository.findById(rows["mail"]!, acme);
    await AppRepository.tombstone(app!);
    expect(await db.select().from(providerConnections)).toEqual([]);
  });
});
