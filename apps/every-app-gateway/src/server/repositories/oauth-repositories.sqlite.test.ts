import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  seedMember,
  seedOrganization,
  testDbProxy,
  type TestDb,
} from "@/test/sqlite-db";
import {
  oauthClients,
  oauthStates,
  providerAppAccess,
  providerConnections,
  userAppAccess,
} from "@/db/schema";
import type { ProviderConnection } from "@/server/repositories/ProviderConnectionRepository";
import { isSealed } from "@/server/secrets/sealed";
import { deployLiveApp } from "@/test/registry";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
vi.mock("@/db", () => ({ db: testDbProxy(testDb) }));

const { OAuthClientRepository } = await import("./OAuthClientRepository");
const { ProviderConnectionRepository } = await import(
  "./ProviderConnectionRepository"
);
const { ProviderAppAccessRepository } = await import(
  "./ProviderAppAccessRepository"
);
const { OAuthStatePurpose, OAuthStateRepository } = await import(
  "./OAuthStateRepository"
);

const env = {
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
};
const other = {
  BETTER_AUTH_SECRET: "other-secret-0123456789abcdefghijklmnopqrstuv",
};

beforeEach(async () => {
  testDb.current = await createTestDb();
});

describe("OAuthClientRepository", () => {
  it("seals the secret, lists without it, opens it for the flow, replaces, removes", async () => {
    expect(await OAuthClientRepository.get("github")).toBeNull();
    const stored = await OAuthClientRepository.upsert(
      {
        providerId: "github",
        clientId: "Iv1.abc",
        clientSecret: "shh-secret",
        boundTo: "key-1",
        addedBy: "ben@example.com",
        now: new Date(1000),
      },
      env,
    );
    expect(stored).toMatchObject({
      providerId: "github",
      clientId: "Iv1.abc",
      hasSecret: true,
      boundTo: "key-1",
      addedBy: "ben@example.com",
      addedAt: 1000,
      updatedAt: 1000,
    });
    expect(JSON.stringify(stored)).not.toContain("shh-secret");
    const [raw] = await testDb.current!.select().from(oauthClients);
    expect(raw!.clientSecretEnc).not.toContain("shh-secret");
    expect(isSealed(raw!.clientSecretEnc!)).toBe(true);

    expect(await OAuthClientRepository.credentials("github", env)).toEqual({
      clientId: "Iv1.abc",
      secret: "shh-secret",
      boundTo: "key-1",
      lost: false,
    });
    expect(await OAuthClientRepository.credentials("github", other)).toEqual({
      clientId: "Iv1.abc",
      secret: null,
      boundTo: "key-1",
      lost: true,
    });

    const replaced = await OAuthClientRepository.upsert(
      {
        providerId: "github",
        clientId: "Iv1.new",
        clientSecret: null,
        boundTo: "key-2",
        addedBy: "someone-else@example.com",
        now: new Date(2000),
      },
      env,
    );
    expect(replaced).toMatchObject({
      clientId: "Iv1.new",
      hasSecret: false,
      boundTo: "key-2",
      addedBy: "ben@example.com",
      addedAt: 1000,
      updatedAt: 2000,
    });
    expect(await OAuthClientRepository.credentials("github", env)).toEqual({
      clientId: "Iv1.new",
      secret: null,
      boundTo: "key-2",
      lost: false,
    });
    expect(
      (await OAuthClientRepository.all()).map((c) => c.providerId),
    ).toEqual(["github"]);
    expect(await OAuthClientRepository.remove("github")).toBe(true);
    expect(await OAuthClientRepository.remove("github")).toBe(false);
    expect(await OAuthClientRepository.credentials("github", env)).toBeNull();
  });
});

describe("ProviderConnectionRepository", () => {
  const base = {
    organizationId: "org-1",
    providerId: "github",
    userId: "user-1",
    appRowId: "app-crm",
    label: "ben",
    externalId: "42",
    scopes: ["read:user", "repo"],
    accessToken: "gho_access",
    refreshToken: "ghr_refresh",
    expiresAt: 5000,
  };
  const key = {
    organizationId: "org-1",
    providerId: "github",
    userId: "user-1",
  };

  it("stores tokens sealed, lists without them, opens them, replaces on reconnect", async () => {
    const created = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    expect(created.id.startsWith("conn_")).toBe(true);
    expect(created).toMatchObject({
      organizationId: "org-1",
      providerId: "github",
      userId: "user-1",
      label: "ben",
      scopes: ["read:user", "repo"],
      expiresAt: 5000,
      status: "active",
      createdAt: 1000,
      lastUsedAt: null,
    });
    // A connection is the person's, not an app's.
    expect(created).not.toHaveProperty("appRowId");
    expect(JSON.stringify(created)).not.toMatch(/gho_access|ghr_refresh/);
    const [raw] = await testDb.current!.select().from(providerConnections);
    expect(`${raw!.accessTokenEnc}${raw!.refreshTokenEnc}`).not.toMatch(
      /gho_access|ghr_refresh/,
    );

    expect(
      await ProviderConnectionRepository.readTokens(created.id, env),
    ).toEqual({
      accessToken: "gho_access",
      refreshToken: "ghr_refresh",
      expiresAt: 5000,
      version: 0,
      status: "active",
    });
    expect(
      await ProviderConnectionRepository.readTokens(created.id, other),
    ).toBeNull();
    expect(
      await ProviderConnectionRepository.readTokens("conn_missing", env),
    ).toBeNull();

    const again = await ProviderConnectionRepository.upsert(
      {
        ...base,
        label: "ben2",
        scopes: ["read:user"],
        accessToken: "gho_access2",
        refreshToken: null,
        expiresAt: null,
        now: new Date(2000),
      },
      env,
    );
    expect(again.id).toBe(created.id);
    expect(again).toMatchObject({
      label: "ben2",
      scopes: ["read:user"],
      createdAt: 1000,
      updatedAt: 2000,
      expiresAt: null,
    });
    expect(
      await ProviderConnectionRepository.readTokens(created.id, env),
    ).toEqual({
      accessToken: "gho_access2",
      refreshToken: null,
      expiresAt: null,
      version: 1,
      status: "active",
    });
    expect(await ProviderConnectionRepository.find(key)).toMatchObject({
      id: created.id,
    });
    expect(
      await ProviderConnectionRepository.find({ ...key, userId: "user-2" }),
    ).toBeNull();
    expect(await ProviderConnectionRepository.byId(created.id)).toMatchObject({
      id: created.id,
    });
  });

  it("keeps one connection per person and provider: a second upsert replaces the first and keeps its id and createdAt", async () => {
    const first = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    const second = await ProviderConnectionRepository.upsert(
      {
        ...base,
        label: "ben-work",
        externalId: "43",
        scopes: ["repo"],
        accessToken: "gho_second",
        now: new Date(2000),
      },
      env,
    );
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      label: "ben-work",
      externalId: "43",
      scopes: ["repo"],
      createdAt: 1000,
      updatedAt: 2000,
    });
    expect(
      await testDb.current!.select().from(providerConnections),
    ).toHaveLength(1);
    expect(
      (await ProviderConnectionRepository.readTokens(first.id, env))
        ?.accessToken,
    ).toBe("gho_second");

    // Another person, another provider and another organization each have their own.
    const pat = await ProviderConnectionRepository.upsert(
      { ...base, userId: "user-2", now: new Date(3000) },
      env,
    );
    const slack = await ProviderConnectionRepository.upsert(
      { ...base, providerId: "slack", now: new Date(4000) },
      env,
    );
    const elsewhere = await ProviderConnectionRepository.upsert(
      { ...base, organizationId: "org-2", now: new Date(5000) },
      env,
    );
    expect(new Set([first.id, pat.id, slack.id, elsewhere.id]).size).toBe(4);
    expect(
      (await ProviderConnectionRepository.listByOrganization("org-1")).map(
        (c) => c.id,
      ),
    ).toEqual([first.id, pat.id, slack.id]);
    expect(
      (await ProviderConnectionRepository.listByUser("user-1")).map(
        (c) => c.id,
      ),
    ).toEqual([first.id, slack.id, elsewhere.id]);
    expect(await ProviderConnectionRepository.countByProvider("org-1")).toEqual(
      { github: 2, slack: 1 },
    );
    expect(await ProviderConnectionRepository.countByProvider()).toEqual({
      github: 3,
      slack: 1,
    });
  });

  describe("removing a connection", () => {
    const access = (
      userId: string,
      appRowId: string,
      providerId = "github",
      organizationId = "org-1",
    ) => ({ organizationId, providerId, userId, appRowId });
    /** The access rows left, as `provider user app`, sorted. */
    const accessLeft = async () =>
      (await testDb.current!.select().from(providerAppAccess))
        .map((row) => `${row.providerId} ${row.userId} ${row.appRowId}`)
        .sort();
    let mine: ProviderConnection;
    let pats: { id: string };

    beforeEach(async () => {
      mine = await ProviderConnectionRepository.upsert(base, env);
      pats = await ProviderConnectionRepository.upsert(
        { ...base, userId: "user-2" },
        env,
      );
      await ProviderConnectionRepository.upsert(
        { ...base, providerId: "slack" },
        env,
      );
      for (const key of [
        access("user-1", "app-crm"),
        access("user-1", "app-ci"),
        access("user-2", "app-crm"),
        access("user-1", "app-crm", "slack"),
      ]) {
        await ProviderAppAccessRepository.allow({ ...key, scopes: ["repo"] });
      }
    });

    it("removes one connection with every app's access to it, and leaves other people's and other providers'", async () => {
      expect(await ProviderConnectionRepository.remove(mine)).toBe(true);
      expect(await ProviderConnectionRepository.byId(mine.id)).toBeNull();
      expect(await accessLeft()).toEqual([
        "github user-2 app-crm",
        "slack user-1 app-crm",
      ]);
      expect(await ProviderConnectionRepository.byId(pats.id)).not.toBeNull();
      // Already gone: nothing more is taken.
      expect(await ProviderConnectionRepository.remove(mine)).toBe(false);
      expect(await accessLeft()).toHaveLength(2);
    });

    it("removes a member's connections in an organization with the access apps had to them, and leaves other members'", async () => {
      expect(
        await ProviderConnectionRepository.removeForMember("org-2", "user-1"),
      ).toBe(0);
      expect(await accessLeft()).toHaveLength(4);
      // Both of user-1's: GitHub and Slack.
      expect(
        await ProviderConnectionRepository.removeForMember("org-1", "user-1"),
      ).toBe(2);
      expect(await ProviderConnectionRepository.listByUser("user-1")).toEqual(
        [],
      );
      expect(await accessLeft()).toEqual(["github user-2 app-crm"]);
      expect(await ProviderConnectionRepository.byId(pats.id)).not.toBeNull();
    });

    it("removes every connection to a provider with the access apps had to them, and leaves other providers'", async () => {
      expect(
        await ProviderConnectionRepository.removeAllForProvider("github"),
      ).toBe(2);
      expect(
        (await ProviderConnectionRepository.listByOrganization("org-1")).map(
          (c) => c.providerId,
        ),
      ).toEqual(["slack"]);
      expect(await accessLeft()).toEqual(["slack user-1 app-crm"]);
    });
  });

  it("lists a remote MCP server's tools with a connection whose person allowed that app only", async () => {
    const latest = () =>
      ProviderConnectionRepository.latestActiveForApp(
        "org-1",
        "github",
        "app-crm",
      );
    const mine = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    const pats = await ProviderConnectionRepository.upsert(
      { ...base, userId: "user-2", now: new Date(2000) },
      env,
    );
    // Connected, and nobody allowed the app: no connection for it.
    expect(await latest()).toBeNull();
    // The same person and app allowed in another organization lets nothing in.
    await ProviderAppAccessRepository.allow({
      ...key,
      organizationId: "org-2",
      appRowId: "app-crm",
      scopes: ["repo"],
    });
    expect(await latest()).toBeNull();
    // Pat's is the one used most recently, but Pat allowed another app.
    await ProviderConnectionRepository.touchLastUsed(pats.id, new Date(9000));
    await ProviderAppAccessRepository.allow({
      ...key,
      userId: "user-2",
      appRowId: "app-ci",
      scopes: ["repo"],
    });
    expect(await latest()).toBeNull();
    await ProviderAppAccessRepository.allow({
      ...key,
      appRowId: "app-crm",
      scopes: ["repo"],
    });
    expect(await latest()).toMatchObject({ id: mine.id, userId: "user-1" });
    // Once Pat allows it too, the one used most recently wins.
    await ProviderAppAccessRepository.allow({
      ...key,
      userId: "user-2",
      appRowId: "app-crm",
      scopes: ["repo"],
    });
    expect(await latest()).toMatchObject({ id: pats.id, userId: "user-2" });
    // An expired connection is never the one.
    await ProviderConnectionRepository.markExpired(pats.id);
    expect(await latest()).toMatchObject({ id: mine.id });
  });

  it("leases a refresh once per version of the tokens, for 30 seconds", async () => {
    const Connections = ProviderConnectionRepository;
    const conn = await Connections.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    const now = new Date(10_000);
    expect(await Connections.claimRefresh(conn.id, 0, now)).toBe(true);
    expect(await Connections.claimRefresh(conn.id, 0, now)).toBe(false);
    // Still held a moment before it lapses, free a moment after.
    expect(await Connections.claimRefresh(conn.id, 0, new Date(39_999))).toBe(
      false,
    );
    expect(await Connections.claimRefresh(conn.id, 0, new Date(40_001))).toBe(
      true,
    );
    await Connections.releaseRefresh(conn.id, 0);
    expect(await Connections.claimRefresh(conn.id, 0, now)).toBe(true);
    // Tokens another version by now: nothing to lease, nothing released.
    await Connections.releaseRefresh(conn.id, 7);
    expect(await Connections.claimRefresh(conn.id, 7, new Date(90_000))).toBe(
      false,
    );
  });

  it("stores refreshed tokens and marks expired only for the version that was read", async () => {
    const Connections = ProviderConnectionRepository;
    const conn = await Connections.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    expect(await Connections.readTokens(conn.id, env)).toMatchObject({
      version: 0,
      status: "active",
    });
    expect(await Connections.claimRefresh(conn.id, 0, new Date(10_000))).toBe(
      true,
    );
    // A refresh that returned no refresh token keeps the old one; the
    // lease goes with the store.
    expect(
      await Connections.storeTokens(
        conn.id,
        {
          accessToken: "gho_fresh",
          refreshToken: null,
          expiresAt: 99_000,
          now: new Date(11_000),
          version: 0,
        },
        env,
      ),
    ).toBe(true);
    expect(await Connections.readTokens(conn.id, env)).toEqual({
      accessToken: "gho_fresh",
      refreshToken: "ghr_refresh",
      expiresAt: 99_000,
      version: 1,
      status: "active",
    });
    expect(await Connections.claimRefresh(conn.id, 1, new Date(11_000))).toBe(
      true,
    );

    // A second refresh that read version 0 stores nothing and expires nothing.
    expect(
      await Connections.storeTokens(
        conn.id,
        {
          accessToken: "gho_stale",
          refreshToken: "ghr_stale",
          expiresAt: null,
          version: 0,
        },
        env,
      ),
    ).toBe(false);
    expect(await Connections.markExpired(conn.id, new Date(12_000), 0)).toBe(
      false,
    );
    expect(await Connections.readTokens(conn.id, env)).toMatchObject({
      accessToken: "gho_fresh",
      version: 1,
      status: "active",
    });

    expect(
      await Connections.storeTokens(
        conn.id,
        {
          accessToken: "gho_fresh2",
          refreshToken: "ghr_rotated",
          expiresAt: null,
          scopes: ["repo"],
          version: 1,
        },
        env,
      ),
    ).toBe(true);
    expect(await Connections.readTokens(conn.id, env)).toEqual({
      accessToken: "gho_fresh2",
      refreshToken: "ghr_rotated",
      expiresAt: null,
      version: 2,
      status: "active",
    });
    expect((await Connections.byId(conn.id))?.scopes).toEqual(["repo"]);

    // Expired by the one call that changes it, and not twice.
    expect(await Connections.markExpired(conn.id, new Date(12_000), 2)).toBe(
      true,
    );
    expect(await Connections.markExpired(conn.id, new Date(13_000), 2)).toBe(
      false,
    );
    expect(await Connections.byId(conn.id)).toMatchObject({
      status: "expired",
      updatedAt: 12_000,
    });
    // Connecting again is a new version: a refresh still out stores nothing.
    await Connections.upsert({ ...base, now: new Date(14_000) }, env);
    expect(await Connections.readTokens(conn.id, env)).toMatchObject({
      version: 3,
      status: "active",
    });

    await Connections.touchLastUsed(conn.id, new Date(15_000));
    expect((await Connections.byId(conn.id))?.lastUsedAt).toBe(15_000);
    expect(await Connections.remove(conn)).toBe(true);
    expect(await Connections.remove(conn)).toBe(false);
  });
});

describe("ProviderAppAccessRepository", () => {
  const key = {
    organizationId: "org-1",
    providerId: "github",
    userId: "user-1",
    appRowId: "app-crm",
  };

  it("allows an app, finds its access, and takes it away", async () => {
    expect(await ProviderAppAccessRepository.find(key)).toBeNull();
    await ProviderAppAccessRepository.allow({
      ...key,
      scopes: ["repo", "read:user"],
      now: new Date(1000),
    });
    expect(await ProviderAppAccessRepository.find(key)).toEqual({
      providerId: key.providerId,
      userId: key.userId,
      appRowId: key.appRowId,
      scopes: ["repo", "read:user"],
    });
    // Another app, person, provider or organization has none.
    for (const other of [
      { appRowId: "app-ci" },
      { userId: "user-2" },
      { providerId: "slack" },
      { organizationId: "org-2" },
    ]) {
      expect(
        await ProviderAppAccessRepository.find({ ...key, ...other }),
      ).toBeNull();
    }
    expect(await ProviderAppAccessRepository.remove(key)).toBe(true);
    expect(await ProviderAppAccessRepository.find(key)).toBeNull();
    expect(await ProviderAppAccessRepository.remove(key)).toBe(false);
  });

  it("replaces the scopes when the person allows the app again, and keeps createdAt", async () => {
    await ProviderAppAccessRepository.allow({
      ...key,
      scopes: ["repo"],
      now: new Date(1000),
    });
    await ProviderAppAccessRepository.allow({
      ...key,
      scopes: ["repo", "workflow"],
      now: new Date(2000),
    });
    const rows = await testDb.current!.select().from(providerAppAccess);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopes: JSON.stringify(["repo", "workflow"]),
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
    });
  });

  it("lists an organization's access oldest first, and takes away one person's for a connection or for an app", async () => {
    const rows = [
      { ...key, now: new Date(1000) },
      { ...key, appRowId: "app-ci", now: new Date(2000) },
      { ...key, providerId: "slack", now: new Date(3000) },
      { ...key, userId: "user-2", now: new Date(4000) },
      { ...key, organizationId: "org-2", now: new Date(5000) },
    ];
    for (const row of rows) {
      await ProviderAppAccessRepository.allow({ ...row, scopes: ["repo"] });
    }
    const listed = async () =>
      (await ProviderAppAccessRepository.listByOrganization("org-1")).map(
        (row) => `${row.providerId} ${row.userId} ${row.appRowId}`,
      );
    expect(await listed()).toEqual([
      "github user-1 app-crm",
      "github user-1 app-ci",
      "slack user-1 app-crm",
      "github user-2 app-crm",
    ]);
    // They connected another GitHub account: every app's access to that connection.
    await ProviderAppAccessRepository.removeForConnection({
      organizationId: "org-1",
      providerId: "github",
      userId: "user-1",
    });
    expect(await listed()).toEqual([
      "slack user-1 app-crm",
      "github user-2 app-crm",
    ]);
    // They lost crm: that app's access to each of their connections.
    await ProviderAppAccessRepository.removeForMemberApp({
      organizationId: "org-1",
      userId: "user-1",
      appRowId: "app-crm",
    });
    expect(await listed()).toEqual(["github user-2 app-crm"]);
    expect(
      await ProviderAppAccessRepository.listByOrganization("org-2"),
    ).toHaveLength(1);
  });

  it("takes away the access of people who no longer open the app, and keeps their connection", async () => {
    const db = testDb.current!;
    const acme = await seedOrganization(db, "acme");
    const owner = await seedMember(db, {
      organizationId: acme,
      role: "owner",
    });
    const pat = await seedMember(db, { organizationId: acme });
    const sam = await seedMember(db, { organizationId: acme });
    const { app: crm } = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "crm",
    });
    const { app: ci } = await deployLiveApp(db, {
      organizationId: acme,
      appSlug: "ci",
    });
    // Pat opens both by a grant; Sam opens crm alone.
    await db.insert(userAppAccess).values([
      { id: "pat-crm", organizationId: acme, userId: pat, appRowId: crm.id },
      { id: "pat-ci", organizationId: acme, userId: pat, appRowId: ci.id },
      { id: "sam-crm", organizationId: acme, userId: sam, appRowId: crm.id },
    ]);
    const connections: Record<string, string> = {};
    for (const userId of [owner, pat, sam]) {
      const person = { organizationId: acme, providerId: "github", userId };
      connections[userId] = (
        await ProviderConnectionRepository.upsert(
          {
            ...person,
            appRowId: "app-crm",
            label: null,
            externalId: null,
            scopes: ["repo"],
            accessToken: "gho_access",
            refreshToken: null,
            expiresAt: null,
          },
          env,
        )
      ).id;
      for (const appRowId of userId === sam ? [crm.id] : [crm.id, ci.id]) {
        await ProviderAppAccessRepository.allow({
          ...person,
          appRowId,
          scopes: ["repo"],
        });
      }
    }
    const left = async () =>
      (await ProviderAppAccessRepository.listByOrganization(acme))
        .map((row) => `${row.userId} ${row.appRowId}`)
        .sort();
    // Everyone still opens what they allowed: nothing goes.
    expect(await ProviderAppAccessRepository.pruneWithoutAccess(acme)).toBe(0);
    expect(await left()).toHaveLength(5);

    // Pat's grant to crm is revoked.
    await db.delete(userAppAccess).where(eq(userAppAccess.id, "pat-crm"));
    expect(await ProviderAppAccessRepository.pruneWithoutAccess(acme)).toBe(1);
    expect(await left()).toEqual(
      [
        `${owner} ${crm.id}`,
        `${owner} ${ci.id}`,
        `${pat} ${ci.id}`,
        `${sam} ${crm.id}`,
      ].sort(),
    );
    // Pat's connection stays: ci still uses it.
    expect(
      await ProviderConnectionRepository.byId(connections[pat]!),
    ).toMatchObject({ userId: pat, status: "active" });
    expect(
      await ProviderConnectionRepository.listByOrganization(acme),
    ).toHaveLength(3);
    // Another organization's prune touches nothing here.
    expect(await ProviderAppAccessRepository.pruneWithoutAccess("org-2")).toBe(
      0,
    );
    expect(await left()).toHaveLength(4);
  });
});

describe("OAuthStateRepository", () => {
  const input = {
    state: "state-1",
    providerId: "github",
    organizationId: "org-1",
    userId: "user-1",
    appRowId: "app-crm",
    purpose: OAuthStatePurpose.Authorize,
    codeVerifier: "verifier-1",
    scopes: ["read:user", "repo"],
    returnTo: "/settings/connections",
  };

  it("is taken once", async () => {
    const put = await OAuthStateRepository.put({
      ...input,
      now: new Date(1000),
    });
    expect(put.expiresAt).toBe(1000 + 10 * 60 * 1000);
    const taken = await OAuthStateRepository.take("state-1", new Date(2000));
    expect(taken).toMatchObject({
      state: "state-1",
      providerId: "github",
      organizationId: "org-1",
      userId: "user-1",
      appRowId: "app-crm",
      purpose: "authorize",
      codeVerifier: "verifier-1",
      scopes: ["read:user", "repo"],
      returnTo: "/settings/connections",
      createdAt: 1000,
    });
    expect(
      await OAuthStateRepository.take("state-1", new Date(2000)),
    ).toBeNull();
    expect(
      await OAuthStateRepository.take("state-x", new Date(2000)),
    ).toBeNull();
  });

  it("is read by peek as often as asked and left in place, until take spends it", async () => {
    await OAuthStateRepository.put({
      ...input,
      purpose: OAuthStatePurpose.Allow,
      codeVerifier: "",
      now: new Date(1000),
    });
    const shown = await OAuthStateRepository.peek("state-1", new Date(2000));
    expect(shown).toMatchObject({
      state: "state-1",
      purpose: OAuthStatePurpose.Allow,
      appRowId: "app-crm",
      scopes: ["read:user", "repo"],
      returnTo: "/settings/connections",
    });
    expect(await OAuthStateRepository.peek("state-1", new Date(2000))).toEqual(
      shown,
    );
    expect(await testDb.current!.select().from(oauthStates)).toHaveLength(1);
    expect(
      await OAuthStateRepository.peek("state-x", new Date(2000)),
    ).toBeNull();
    // Expired: peek shows nothing.
    expect(
      await OAuthStateRepository.peek("state-1", new Date(1000 + 11 * 60_000)),
    ).toBeNull();

    expect(await OAuthStateRepository.take("state-1", new Date(2000))).toEqual(
      shown,
    );
    expect(await testDb.current!.select().from(oauthStates)).toEqual([]);
    expect(
      await OAuthStateRepository.peek("state-1", new Date(2000)),
    ).toBeNull();
  });

  it("keeps a state's purpose: authorize for the provider's callback, allow for the Allow page", async () => {
    const authorize = await OAuthStateRepository.put({
      ...input,
      state: "state-authorize",
      now: new Date(1000),
    });
    const allow = await OAuthStateRepository.put({
      ...input,
      state: "state-allow",
      purpose: OAuthStatePurpose.Allow,
      now: new Date(1000),
    });
    expect(authorize.purpose).toBe("authorize");
    expect(allow.purpose).toBe("allow");
    expect(
      (await OAuthStateRepository.peek("state-authorize", new Date(2000)))
        ?.purpose,
    ).toBe("authorize");
    expect(
      (await OAuthStateRepository.take("state-allow", new Date(2000)))?.purpose,
    ).toBe("allow");
    expect(
      (await OAuthStateRepository.take("state-authorize", new Date(2000)))
        ?.purpose,
    ).toBe("authorize");
  });

  it("removes a person's unspent allow states for one provider in one organization, and nothing else", async () => {
    const allow = {
      ...input,
      purpose: OAuthStatePurpose.Allow,
      codeVerifier: "",
    };
    for (const state of [
      // Two Allow pages the person left open, for two apps.
      { ...allow, state: "allow-crm" },
      { ...allow, state: "allow-ci", appRowId: "app-ci" },
      // Theirs too, and not this call's: a connect at the provider, another
      // provider's Allow page, the same provider in another organization.
      { ...input, state: "authorize-crm" },
      { ...allow, state: "allow-slack", providerId: "slack" },
      { ...allow, state: "allow-elsewhere", organizationId: "org-2" },
      // Another person's Allow page for the same provider.
      { ...allow, state: "allow-pat", userId: "user-2" },
    ]) {
      await OAuthStateRepository.put({ ...state, now: new Date(1000) });
    }
    const left = async () =>
      (await testDb.current!.select().from(oauthStates))
        .map((row) => row.state)
        .sort();
    const key = {
      organizationId: "org-1",
      providerId: "github",
      userId: "user-1",
    };

    expect(await OAuthStateRepository.removeAllow(key)).toBe(2);
    expect(await left()).toEqual([
      "allow-elsewhere",
      "allow-pat",
      "allow-slack",
      "authorize-crm",
    ]);
    // Removed, they are spent: neither read nor taken.
    for (const state of ["allow-crm", "allow-ci"]) {
      expect(await OAuthStateRepository.peek(state, new Date(2000))).toBeNull();
      expect(await OAuthStateRepository.take(state, new Date(2000))).toBeNull();
    }
    // The connect at the provider is still the callback's to finish.
    expect(
      await OAuthStateRepository.peek("authorize-crm", new Date(2000)),
    ).toMatchObject({ purpose: "authorize", userId: "user-1" });
    // Nothing left of theirs to remove.
    expect(await OAuthStateRepository.removeAllow(key)).toBe(0);
    expect(await left()).toHaveLength(4);
  });

  it("refuses an expired state and purges expired rows on put", async () => {
    // A state lives ten minutes.
    const later = 1000 + 10 * 60 * 1000 + 4000;
    await OAuthStateRepository.put({ ...input, now: new Date(1000) });
    expect(
      await OAuthStateRepository.take("state-1", new Date(later)),
    ).toBeNull();
    await OAuthStateRepository.put({
      ...input,
      state: "state-2",
      now: new Date(1000),
    });
    await OAuthStateRepository.put({
      ...input,
      state: "state-3",
      now: new Date(later),
    });
    expect(
      await OAuthStateRepository.take("state-2", new Date(later)),
    ).toBeNull();
    expect(await OAuthStateRepository.purgeExpired(new Date(later))).toBe(0);
    expect(
      await OAuthStateRepository.take("state-3", new Date(later + 1)),
    ).not.toBeNull();
  });
});
