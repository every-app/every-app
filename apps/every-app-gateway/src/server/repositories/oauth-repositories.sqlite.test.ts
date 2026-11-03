import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, testDbProxy, type TestDb } from "@/test/sqlite-db";
import { oauthClients, providerConnections } from "@/db/schema";
import { isSealed } from "@/server/secrets/sealed";

const testDb = vi.hoisted(() => ({ current: null as TestDb | null }));
vi.mock("@/db", () => ({ db: testDbProxy(testDb) }));

const { OAuthClientRepository } = await import("./OAuthClientRepository");
const { ProviderConnectionRepository } = await import(
  "./ProviderConnectionRepository"
);
const { OAuthStateRepository } = await import("./OAuthStateRepository");

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
    appRowId: "app-crm",
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
      appRowId: "app-crm",
      label: "ben",
      scopes: ["read:user", "repo"],
      expiresAt: 5000,
      status: "active",
      createdAt: 1000,
      lastUsedAt: null,
    });
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
    });
    expect(await ProviderConnectionRepository.find(key)).toMatchObject({
      id: created.id,
    });
    expect(
      await ProviderConnectionRepository.find({ ...key, appRowId: "app-ci" }),
    ).toBeNull();
    expect(await ProviderConnectionRepository.byId(created.id)).toMatchObject({
      id: created.id,
    });
  });

  it("keeps one connection per person per app, lists them, and removes them by member, app and provider", async () => {
    const crm = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    const ci = await ProviderConnectionRepository.upsert(
      { ...base, appRowId: "app-ci", now: new Date(2000) },
      env,
    );
    const pat = await ProviderConnectionRepository.upsert(
      { ...base, userId: "user-2", now: new Date(3000) },
      env,
    );
    const elsewhere = await ProviderConnectionRepository.upsert(
      { ...base, organizationId: "org-2", now: new Date(4000) },
      env,
    );
    expect(
      (await ProviderConnectionRepository.listByOrganization("org-1")).map(
        (c) => c.id,
      ),
    ).toEqual([crm.id, ci.id, pat.id]);
    expect(
      (await ProviderConnectionRepository.listByUser("user-1")).map(
        (c) => c.id,
      ),
    ).toEqual([crm.id, ci.id, elsewhere.id]);
    expect(await ProviderConnectionRepository.countByProvider("org-1")).toEqual(
      { github: 3 },
    );
    expect(await ProviderConnectionRepository.countByProvider()).toEqual({
      github: 4,
    });
    expect(
      await ProviderConnectionRepository.removeForMemberApp({
        organizationId: "org-1",
        userId: "user-1",
        appRowId: "app-ci",
      }),
    ).toBe(1);
    expect(await ProviderConnectionRepository.removeForApp("app-crm")).toBe(3);
    expect(
      (await ProviderConnectionRepository.listByOrganization("org-1")).map(
        (c) => c.id,
      ),
    ).toEqual([]);
    const back = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(5000) },
      env,
    );
    expect(
      await ProviderConnectionRepository.removeForMember("org-2", "user-1"),
    ).toBe(0);
    expect(
      await ProviderConnectionRepository.removeForMember("org-1", "user-1"),
    ).toBe(1);
    expect(await ProviderConnectionRepository.byId(back.id)).toBeNull();
    await ProviderConnectionRepository.upsert(base, env);
    expect(
      await ProviderConnectionRepository.removeAllForProvider("github"),
    ).toBe(1);
    expect(await ProviderConnectionRepository.listByUser("user-1")).toEqual([]);
  });

  it("leases a refresh once, stores the refreshed tokens, marks expired, touches, removes", async () => {
    const conn = await ProviderConnectionRepository.upsert(
      { ...base, now: new Date(1000) },
      env,
    );
    const now = new Date(10_000);
    expect(
      await ProviderConnectionRepository.tryLease(conn.id, now, 40_000),
    ).toBe(true);
    expect(
      await ProviderConnectionRepository.tryLease(conn.id, now, 40_000),
    ).toBe(false);
    expect(
      await ProviderConnectionRepository.tryLease(
        conn.id,
        new Date(50_000),
        90_000,
      ),
    ).toBe(true);
    await ProviderConnectionRepository.releaseLease(conn.id);
    expect(
      await ProviderConnectionRepository.tryLease(conn.id, now, 40_000),
    ).toBe(true);

    await ProviderConnectionRepository.storeTokens(
      conn.id,
      {
        accessToken: "gho_fresh",
        refreshToken: null,
        expiresAt: 99_000,
        now: new Date(11_000),
      },
      env,
    );
    expect(await ProviderConnectionRepository.readTokens(conn.id, env)).toEqual(
      {
        accessToken: "gho_fresh",
        refreshToken: "ghr_refresh",
        expiresAt: 99_000,
      },
    );
    expect(
      await ProviderConnectionRepository.tryLease(conn.id, now, 40_000),
    ).toBe(true);

    await ProviderConnectionRepository.storeTokens(
      conn.id,
      {
        accessToken: "gho_fresh2",
        refreshToken: "ghr_rotated",
        expiresAt: null,
        scopes: ["repo"],
      },
      env,
    );
    expect(await ProviderConnectionRepository.readTokens(conn.id, env)).toEqual(
      {
        accessToken: "gho_fresh2",
        refreshToken: "ghr_rotated",
        expiresAt: null,
      },
    );
    expect((await ProviderConnectionRepository.byId(conn.id))?.scopes).toEqual([
      "repo",
    ]);

    await ProviderConnectionRepository.markExpired(conn.id, new Date(12_000));
    expect(await ProviderConnectionRepository.byId(conn.id)).toMatchObject({
      status: "expired",
      updatedAt: 12_000,
    });
    await ProviderConnectionRepository.touchLastUsed(conn.id, new Date(13_000));
    expect((await ProviderConnectionRepository.byId(conn.id))?.lastUsedAt).toBe(
      13_000,
    );
    expect(await ProviderConnectionRepository.remove(conn.id)).toBe(true);
    expect(await ProviderConnectionRepository.remove(conn.id)).toBe(false);
  });
});

describe("OAuthStateRepository", () => {
  const input = {
    state: "state-1",
    providerId: "github",
    organizationId: "org-1",
    userId: "user-1",
    appRowId: "app-crm",
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

  it("refuses an expired state and purges expired rows on put", async () => {
    await OAuthStateRepository.put({
      ...input,
      now: new Date(1000),
      ttlMs: 500,
    });
    expect(
      await OAuthStateRepository.take("state-1", new Date(2000)),
    ).toBeNull();
    await OAuthStateRepository.put({
      ...input,
      state: "state-2",
      now: new Date(1000),
      ttlMs: 500,
    });
    await OAuthStateRepository.put({
      ...input,
      state: "state-3",
      now: new Date(5000),
    });
    expect(
      await OAuthStateRepository.take("state-2", new Date(5000)),
    ).toBeNull();
    expect(await OAuthStateRepository.purgeExpired(new Date(5000))).toBe(0);
    expect(
      await OAuthStateRepository.take("state-3", new Date(5001)),
    ).not.toBeNull();
  });
});
