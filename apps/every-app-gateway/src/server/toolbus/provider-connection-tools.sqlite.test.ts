/**
 * `everyapp_provider_connections` and `everyapp_provider_disconnect` on the
 * gateway's own /mcp against a migrated SQLite database: a member lists
 * and removes their own connections and nobody else's, an owner or admin
 * the whole organization's (`all`, `user`); each connection is one
 * person's to one provider, and the answer names the person and the apps
 * they allowed to use it; no answer carries a token; a disconnect removes
 * the connection for every app, emits `provider.disconnected` and says
 * whether the grant was revoked; with `app` it takes that one app's access
 * away and leaves the connection; and `everyapp_provider_add { preset }`
 * registers a preset as a row and answers the redirect URI. Drives
 * serveGatewayMcp with resolved callers, as provider-tools.sqlite.test.ts
 * does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: "https://gateway.example.com",
    APP_BASE_DOMAIN: "apps.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    DB: {},
  } as Record<string, unknown>,
  waitUntil: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: hoisted.waitUntil,
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => hoisted.testDb.current }));
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));

import { generateKeyPairSync } from "node:crypto";
import type { McpPrincipal } from "@every-app/toolbus";
import { eq } from "drizzle-orm";
import { events, providerAppAccess, providers } from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { resetGatewayProvidersForTests } from "@/server/providers";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { clearCatalogSyncClaimsForTests } from "./catalog-sync";
import { serveGatewayMcp } from "./gateway-mcp";
import { resetToolBusForTests } from "./runtime";

const GATEWAY = "https://gateway.example.com";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let otherId: string;
/** App row ids by slug: seo and mail, both listing google-workspace. */
const appRows: Record<string, string> = {};

function callerFor(
  userId: string,
  orgRole: string,
  principal: Partial<McpPrincipal> = {},
): McpCaller {
  return {
    kind: "caller",
    principal: {
      userId,
      email: `${orgRole}@example.com`,
      organizationId,
      organizationName: "acme",
      orgRole,
      credential: { kind: "pat", id: `pat_${orgRole}_${userId}` },
      access: "write",
      ...principal,
    },
    apps: {},
  };
}
const owner = () => callerFor(ownerId, "owner");
const admin = () => callerFor(adminId, "admin");
const member = () => callerFor(memberId, "member");

function mcp(
  method: string,
  params: Record<string, unknown>,
  as: McpCaller,
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return serveGatewayMcp(
    new Request(`${GATEWAY}/mcp`, {
      method: "POST",
      headers: {
        host: "gateway.example.com",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: MODERN_META },
      }),
    }),
    as,
  );
}

async function settle(): Promise<void> {
  await Promise.all(
    hoisted.waitUntil.mock.calls.map(([task]) => Promise.resolve(task)),
  );
}

type Answer =
  | { ok: true; data: Record<string, unknown>; text: string }
  | { ok: false; error: string }
  | { ok: false; unknown: true; message: string };

async function call(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<Answer> {
  const response = await mcp("tools/call", { name, arguments: args }, as);
  const body = (await response.json()) as {
    result?: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: { message: string };
  };
  await settle();
  if (body.error)
    return { ok: false, unknown: true, message: body.error.message };
  const result = body.result!;
  const text = result.content[0]?.text ?? "";
  if (result.isError) return { ok: false, error: text };
  return { ok: true, data: result.structuredContent ?? {}, text };
}

async function data(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<Record<string, unknown>> {
  const answer = await call(name, args, as);
  if (!answer.ok) {
    throw new Error(
      `${name} refused: ${"error" in answer ? answer.error : answer.message}`,
    );
  }
  return answer.data;
}

async function refusal(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<string> {
  const answer = await call(name, args, as);
  if (answer.ok) throw new Error(`${name} answered ${answer.text}`);
  return "error" in answer ? answer.error : answer.message;
}

type Listed = {
  id: string;
  provider: string;
  userId: string;
  userEmail?: string;
  apps: { rowId: string; id: string; name: string }[];
  label: string | null;
  scopes: string[];
  status: string;
};

/** Each connection's person and the ids of the apps allowed to use it. */
function appsByPerson(listed: Listed[]): Record<string, string[]> {
  return Object.fromEntries(
    listed.map((each) => [each.userId, each.apps.map((app) => app.id)]),
  );
}

async function connections(
  as: McpCaller,
  args: Record<string, unknown> = {},
): Promise<Listed[]> {
  return (await data("everyapp_provider_connections", args, as))[
    "connections"
  ] as Listed[];
}

const APP_SCOPES: Record<string, string[]> = {
  seo: ["webmasters.readonly"],
  mail: ["gmail.modify"],
};

/**
 * A person's connection as the callback writes one, with a sealed token
 * nobody should see, and the apps they allowed to use it (seo, unless
 * said).
 */
async function connect(input: {
  providerId?: string;
  userId: string;
  apps?: string[];
  label: string;
}): Promise<string> {
  const person = {
    organizationId,
    providerId: input.providerId ?? "google-workspace",
    userId: input.userId,
  };
  const row = await ProviderConnectionRepository.upsert(
    {
      ...person,
      appRowId: appRows["seo"]!,
      label: input.label,
      externalId: null,
      scopes: ["webmasters.readonly", "gmail.modify", "openid", "email"],
      accessToken: `ya29.secret-token-for-${input.label}`,
      refreshToken: `1//refresh-${input.label}`,
      expiresAt: Date.now() + 3_600_000,
    },
    hoisted.env as { BETTER_AUTH_SECRET?: string },
  );
  for (const app of input.apps ?? ["seo"]) {
    await ProviderAppAccessRepository.allow({
      ...person,
      appRowId: appRows[app]!,
      scopes: APP_SCOPES[app]!,
    });
  }
  return row.id;
}

async function providerEvents(type: string) {
  return db
    .select({ type: events.type, data: events.data })
    .from(events)
    .where(eq(events.type, type));
}

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "self_hosted";
});

beforeEach(async () => {
  db = await createTestDb();
  hoisted.testDb.current = db;
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  hoisted.env["JWT_PRIVATE_KEY"] = pair.privateKey;
  organizationId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId,
    role: "owner",
    email: "owner@example.com",
  });
  adminId = await seedMember(db, {
    organizationId,
    role: "admin",
    email: "admin@example.com",
  });
  memberId = await seedMember(db, {
    organizationId,
    role: "member",
    email: "member@example.com",
  });
  otherId = await seedMember(db, {
    organizationId,
    role: "member",
    email: "other@example.com",
  });
  for (const [slug, scopes] of [
    ["seo", ["webmasters.readonly"]],
    ["mail", ["gmail.modify"]],
  ] as const) {
    const plan = await deployLiveApp(db, {
      organizationId,
      appSlug: slug,
      manifest: {
        id: slug,
        capabilities: {
          "google-workspace": { scopes: [...scopes], why: "Reads it." },
        },
      },
      deployerUserId: ownerId,
    });
    appRows[slug] = plan.app.id;
  }
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetGatewayProvidersForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the connection tools on /mcp", () => {
  it("lists a member's own connections, each once with the apps allowed to use it, and with all the organization's for an owner or admin only, never a token", async () => {
    await connect({
      userId: memberId,
      apps: ["seo", "mail"],
      label: "member@gmail.com",
    });
    await connect({ userId: otherId, label: "other@gmail.com" });

    // One connection to Google, however many apps use it.
    const own = await connections(member());
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      provider: "google-workspace",
      userId: memberId,
      userEmail: "member@example.com",
      // By name.
      apps: [
        { rowId: appRows["mail"], id: "mail", name: "mail" },
        { rowId: appRows["seo"], id: "seo", name: "seo" },
      ],
      label: "member@gmail.com",
      scopes: ["webmasters.readonly", "gmail.modify", "openid", "email"],
      status: "active",
    });
    expect(own[0]).not.toHaveProperty("app");
    // Nothing in the answer looks like a token.
    const answer = await call("everyapp_provider_connections", {}, member());
    expect(answer.ok && answer.text).not.toMatch(/ya29|refresh-/);

    expect(
      await refusal("everyapp_provider_connections", { all: true }, member()),
    ).toMatch(/^ADMIN_REQUIRED: /);
    const all = await connections(admin(), { all: true });
    expect(all).toHaveLength(2);
    expect(appsByPerson(all)).toEqual({
      [memberId]: ["mail", "seo"],
      [otherId]: ["seo"],
    });
    expect(
      (await connections(owner(), { all: true, provider: "nothing" })).length,
    ).toBe(0);
    // An admin's own: none.
    expect(await connections(admin())).toEqual([]);
  });

  it("takes one app's access away with `app` and leaves the connection for the other apps: a member their own, an admin anyone's", async () => {
    const mine = await connect({
      userId: memberId,
      apps: ["seo", "mail"],
      label: "member@gmail.com",
    });
    const others = await connect({
      userId: otherId,
      apps: ["seo", "mail"],
      label: "other@gmail.com",
    });

    // Another person's: refused for a member.
    for (const target of [
      { connection: others },
      { provider: "google-workspace", user: "other@example.com" },
    ]) {
      expect(
        await refusal(
          "everyapp_provider_disconnect",
          { ...target, app: "mail" },
          member(),
        ),
      ).toMatch(/^ADMIN_REQUIRED: /);
    }

    // Their own, by provider and app.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", app: "mail" },
        member(),
      ),
    ).toMatchObject({
      connection: {
        id: mine,
        provider: "google-workspace",
        userId: memberId,
        apps: [{ id: "seo" }],
        status: "active",
      },
      app: "mail",
      removed: true,
      revoked: false,
    });
    // The connection is theirs still, with seo alone.
    expect(
      (await connections(member())).map((each) => [
        each.id,
        each.status,
        each.apps.map((app) => app.id),
      ]),
    ).toEqual([[mine, "active", ["seo"]]]);
    // An app that isn't allowed to use it has nothing to take.
    for (const app of ["mail", "nothing"]) {
      expect(
        await refusal(
          "everyapp_provider_disconnect",
          { provider: "google-workspace", app },
          member(),
        ),
      ).toMatch(/^CONNECTION_NOT_FOUND: /);
    }

    // An admin takes an app off another person's, by connection id or by email.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { connection: others, app: "seo" },
        admin(),
      ),
    ).toMatchObject({
      connection: { id: others, userId: otherId, apps: [{ id: "mail" }] },
      app: "seo",
      removed: true,
    });
    expect(
      await data(
        "everyapp_provider_disconnect",
        {
          provider: "google-workspace",
          user: "other@example.com",
          app: "mail",
        },
        owner(),
      ),
    ).toMatchObject({ connection: { id: others, apps: [] }, removed: true });

    // Both connections stay, and no disconnect was announced.
    const all = await connections(owner(), { all: true });
    expect(all.map((each) => each.status)).toEqual(["active", "active"]);
    expect(appsByPerson(all)).toEqual({ [memberId]: ["seo"], [otherId]: [] });
    expect(await providerEvents("provider.disconnected")).toEqual([]);
  });

  it("lets a member disconnect their own connection only, an admin anyone's by email or id, by provider or connection id, and emits provider.disconnected with no app", async () => {
    const mine = await connect({
      userId: memberId,
      apps: ["seo", "mail"],
      label: "member@gmail.com",
    });
    const others = await connect({
      userId: otherId,
      apps: ["seo", "mail"],
      label: "other@gmail.com",
    });

    // Another person's: refused for a member, before the service is asked.
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", user: "other@example.com" },
        member(),
      ),
    ).toMatch(/^ADMIN_REQUIRED: /);
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { connection: others },
        member(),
      ),
    ).toMatch(/^ADMIN_REQUIRED: /);
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", user: "nobody@example.com" },
        admin(),
      ),
    ).toMatch(/^PROVIDER_CONNECTION_NOT_FOUND: /);
    expect(await refusal("everyapp_provider_disconnect", {}, member())).toMatch(
      /^INVALID_INPUT: /,
    );
    // A connection id names the connection alone.
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { connection: mine, provider: "google-workspace" },
        member(),
      ),
    ).toMatch(/^INVALID_INPUT: /);

    // Their own, by provider: the one connection goes, for both apps.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace" },
        member(),
      ),
    ).toMatchObject({
      connection: {
        id: mine,
        provider: "google-workspace",
        userId: memberId,
        apps: [{ id: "mail" }, { id: "seo" }],
      },
      removed: true,
      revoked: false,
    });
    expect(await connections(member())).toEqual([]);
    expect(
      (await db.select().from(providerAppAccess)).map((row) => row.userId),
    ).toEqual([otherId, otherId]);
    // Again: nothing to remove.
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { provider: "google-workspace" },
        member(),
      ),
    ).toMatch(/^CONNECTION_NOT_FOUND: /);

    // An admin removes another person's by email, and by connection id.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", user: "other@example.com" },
        admin(),
      ),
    ).toMatchObject({
      removed: true,
      connection: { id: others, userId: otherId },
    });
    const again = await connect({ userId: otherId, label: "other@gmail.com" });
    expect(
      await data(
        "everyapp_provider_disconnect",
        { connection: again },
        owner(),
      ),
    ).toMatchObject({
      removed: true,
      connection: { id: again, apps: [{ id: "seo" }] },
    });
    expect(await connections(owner(), { all: true })).toEqual([]);
    // Every app's access went with its connection.
    expect(await db.select().from(providerAppAccess)).toEqual([]);

    // One event a connection: the provider and the account, no app.
    const emitted = await providerEvents("provider.disconnected");
    expect(emitted.length).toBe(3);
    for (const event of emitted) {
      expect(event.data).not.toMatch(/ya29|refresh-|token/i);
      const data = JSON.parse(event.data) as Record<string, unknown>;
      expect(data).toMatchObject({
        provider: { id: "google-workspace", kind: "oauth" },
        account: { user: { id: expect.stringMatching(/^user-/) } },
        revoked: false,
      });
      expect(data).not.toHaveProperty("app");
    }
  });

  it("registers an OAuth preset as a row through everyapp_provider_add { preset } and answers the redirect URI; refuses an unknown preset and both spec and preset", async () => {
    const added = await data(
      "everyapp_provider_add",
      { preset: "github-oauth" },
      admin(),
    );
    expect(added).toMatchObject({
      provider: {
        id: "github-oauth",
        kind: "oauth",
        source: "row",
        redirectUri:
          "https://gateway.example.com/connect/github-oauth/callback",
        hosts: ["api.github.com"],
      },
      bound: false,
    });
    expect(added["provider"]).not.toHaveProperty("scopeSets");
    expect(String(added["next"])).toContain(
      "everyapp secret set GITHUB_OAUTH_CLIENT_ID GITHUB_OAUTH_CLIENT_SECRET",
    );
    const [row] = await db
      .select({ id: providers.id, addedBy: providers.addedBy })
      .from(providers)
      .where(eq(providers.id, "github-oauth"));
    expect(row).toMatchObject({
      id: "github-oauth",
      addedBy: "admin@example.com",
    });
    const emitted = await providerEvents("provider.added");
    expect(emitted.length).toBe(1);
    expect(JSON.parse(emitted[0]!.data)).toMatchObject({
      provider: { id: "github-oauth", kind: "oauth" },
    });

    // Added again (as after a deploy registered it): the row as it is, no second event.
    expect(
      await data("everyapp_provider_add", { preset: "github-oauth" }, admin()),
    ).toMatchObject({ provider: { id: "github-oauth" }, bound: false });
    expect((await providerEvents("provider.added")).length).toBe(1);
    expect(
      await refusal(
        "everyapp_provider_add",
        { preset: "nothing-here" },
        admin(),
      ),
    ).toMatch(
      /^PROVIDER_PRESET_UNKNOWN: |^PROVIDER_NOT_FOUND: |^INVALID_INPUT: /,
    );
    expect(
      await refusal(
        "everyapp_provider_add",
        { preset: "github-oauth", spec: { id: "x" } },
        admin(),
      ),
    ).toBe("INVALID_INPUT: give one of spec or preset, not both");
    expect(await refusal("everyapp_provider_add", {}, admin())).toMatch(
      /^INVALID_INPUT: /,
    );

    // The list carries the row's OAuth facts and the presets.
    const listed = await data("everyapp_provider_list", {}, member());
    const github = (listed["providers"] as Array<Record<string, unknown>>).find(
      (provider) => provider["id"] === "github-oauth",
    );
    expect(github).toMatchObject({
      kind: "oauth_client",
      source: "row",
      redirectUri: "https://gateway.example.com/connect/github-oauth/callback",
      connections: 0,
      client: { set: false },
    });
    const presets = listed["presets"] as Array<Record<string, unknown>>;
    expect(presets.map((preset) => preset["id"])).toContain("github-oauth");
    expect(
      presets.find((preset) => preset["id"] === "google-workspace"),
    ).toMatchObject({ name: "Google" });
    expect(
      presets.find((preset) => preset["id"] === "google-workspace"),
    ).not.toHaveProperty("builtIn");
  });
});
