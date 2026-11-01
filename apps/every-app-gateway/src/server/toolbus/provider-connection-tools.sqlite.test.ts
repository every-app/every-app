/**
 * `everyapp_provider_connections` and `everyapp_provider_disconnect` on the
 * gateway's own /mcp against a migrated SQLite database: a member lists
 * and removes their own connections and nobody else's, an owner or admin
 * the whole organization's and the organization's own (`all`, `user`,
 * `account: organization`); no answer carries a token; a disconnect emits
 * `provider.disconnected` and says whether the grant was revoked; and
 * `everyapp_provider_add { preset }` registers a preset as a row and
 * answers the redirect URI. Drives serveGatewayMcp with resolved callers,
 * as provider-tools.sqlite.test.ts does.
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
import { events, providers } from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { resetGatewayProvidersForTests } from "@/server/providers";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
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
  provider: string;
  account: string;
  userId?: string;
  userEmail?: string;
  label: string | null;
  scopeSets: string[];
  status: string;
};

async function connections(
  as: McpCaller,
  args: Record<string, unknown> = {},
): Promise<Listed[]> {
  return (await data("everyapp_provider_connections", args, as))[
    "connections"
  ] as Listed[];
}

/** A connection as the callback writes one, with a sealed token nobody should see. */
async function connect(input: {
  providerId?: string;
  accountKind: "user" | "organization";
  userId: string | null;
  label: string;
}): Promise<string> {
  const row = await ProviderConnectionRepository.upsert(
    {
      organizationId,
      providerId: input.providerId ?? "google-workspace",
      accountKind: input.accountKind,
      userId: input.userId,
      label: input.label,
      externalId: null,
      scopeSets: ["identity", "search-console.read"],
      scopes: ["openid", "email"],
      accessToken: `ya29.secret-token-for-${input.label}`,
      refreshToken: `1//refresh-${input.label}`,
      expiresAt: Date.now() + 3_600_000,
    },
    hoisted.env as { BETTER_AUTH_SECRET?: string },
  );
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
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetGatewayProvidersForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the connection tools on /mcp", () => {
  it("lists a member's own connections, and with all the organization's for an owner or admin only, never a token", async () => {
    await connect({
      accountKind: "user",
      userId: memberId,
      label: "member@gmail.com",
    });
    await connect({
      accountKind: "user",
      userId: otherId,
      label: "other@gmail.com",
    });
    await connect({
      accountKind: "organization",
      userId: null,
      label: "acme-bot",
    });

    const own = await connections(member());
    expect(
      own.map((each) => [each.provider, each.account, each.label]),
    ).toEqual([["google-workspace", "user", "member@gmail.com"]]);
    expect(own[0]).toMatchObject({
      userId: memberId,
      userEmail: "member@example.com",
      scopeSets: ["identity", "search-console.read"],
      status: "active",
    });
    // Nothing in the answer looks like a token.
    const answer = await call("everyapp_provider_connections", {}, member());
    expect(answer.ok && answer.text).not.toMatch(/ya29|refresh-/);

    expect(
      await refusal("everyapp_provider_connections", { all: true }, member()),
    ).toMatch(/^ADMIN_REQUIRED: /);
    const all = await connections(admin(), { all: true });
    expect(all.map((each) => [each.account, each.label]).sort()).toEqual([
      ["organization", "acme-bot"],
      ["user", "member@gmail.com"],
      ["user", "other@gmail.com"],
    ]);
    expect(
      (await connections(owner(), { all: true, provider: "nothing" })).length,
    ).toBe(0);
    // An admin's own: none.
    expect(await connections(admin())).toEqual([]);
  });

  it("lets a member disconnect their own account only, an admin anyone's by email or id and the organization's, and emits provider.disconnected", async () => {
    await connect({
      accountKind: "user",
      userId: memberId,
      label: "member@gmail.com",
    });
    await connect({
      accountKind: "user",
      userId: otherId,
      label: "other@gmail.com",
    });
    await connect({
      accountKind: "organization",
      userId: null,
      label: "acme-bot",
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
        { provider: "google-workspace", account: "organization" },
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

    // Their own.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace" },
        member(),
      ),
    ).toMatchObject({
      provider: "google-workspace",
      account: "user",
      removed: true,
      revoked: false,
    });
    expect(await connections(member())).toEqual([]);
    // Again: nothing to remove.
    expect(
      await refusal(
        "everyapp_provider_disconnect",
        { provider: "google-workspace" },
        member(),
      ),
    ).toMatch(/^CONNECTION_NOT_FOUND: /);

    // An admin removes another person's by email, and the organization's.
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", user: "other@example.com" },
        admin(),
      ),
    ).toMatchObject({ removed: true, userId: otherId });
    expect(
      await data(
        "everyapp_provider_disconnect",
        { provider: "google-workspace", account: "organization" },
        owner(),
      ),
    ).toMatchObject({ removed: true, account: "organization" });
    expect(await connections(owner(), { all: true })).toEqual([]);

    const emitted = await providerEvents("provider.disconnected");
    expect(emitted.length).toBe(3);
    for (const event of emitted) {
      expect(event.data).not.toMatch(/ya29|refresh-|token/i);
      expect(JSON.parse(event.data)).toMatchObject({
        provider: { id: "google-workspace", kind: "oauth" },
        revoked: false,
      });
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
        connectPath: "/connect/github-oauth",
      },
      bound: false,
    });
    expect((added["provider"] as { scopeSets: string[] }).scopeSets).toContain(
      "identity",
    );
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

    expect(
      await refusal(
        "everyapp_provider_add",
        { preset: "github-oauth" },
        admin(),
      ),
    ).toMatch(/^PROVIDER_EXISTS: /);
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
      flow: "both",
      redirectUri: "https://gateway.example.com/connect/github-oauth/callback",
      connectPath: "/connect/github-oauth",
      connections: 0,
      client: { set: false },
    });
    const presets = listed["presets"] as Array<Record<string, unknown>>;
    expect(presets.map((preset) => preset["id"])).toContain("github-oauth");
    expect(
      presets.find((preset) => preset["id"] === "google-workspace"),
    ).toMatchObject({
      builtIn: true,
    });
  });
});
