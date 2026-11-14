/**
 * The Composio tools on the gateway's own /mcp against a migrated SQLite
 * database and the fake Composio (docs/design/2026-11-composio.md): an
 * owner or admin turns Composio on and off for the organization, and off
 * needs `confirm` while it would delete anything; every member links,
 * reads and unlinks their own Composio, whatever their role, and nobody a
 * colleague's; a read-only connection gets the status alone; and no
 * answer carries the key or the sign-in id. The sign-in's page comes back
 * once, from the start, to the caller who started it. Drives
 * serveGatewayMcp with resolved callers, as
 * provider-connection-tools.sqlite.test.ts does.
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
import {
  composioLinkRequests,
  composioLinks,
  providerAppAccess,
  providerConnections,
} from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { resetGatewayProvidersForTests } from "@/server/providers";
import { OrgSettingsRepository } from "@/server/repositories/OrgSettingsRepository";
import { ProviderAppAccessRepository } from "@/server/repositories/ProviderAppAccessRepository";
import { ProviderConnectionRepository } from "@/server/repositories/ProviderConnectionRepository";
import { fakeComposio, type FakeComposio } from "@/test/fake-composio";
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
const SWITCH = "everyapp_workspace_composio";
const STATUS = "everyapp_provider_composio";
const LINK = "everyapp_provider_composio_link";
const FINISH = "everyapp_provider_composio_link_finish";
const UNLINK = "everyapp_provider_composio_unlink";

let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let crmRowId: string;
let composio: FakeComposio;
/** Every tool answer of the test, as text: what an agent was told. */
let said: string[];
let logged: string[];

/** A resolved caller: a member of Acme, by role, through a personal token unless told otherwise. */
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
      credential: { kind: "pat", id: `pat_${orgRole}` },
      access: "write",
      ...principal,
    },
    apps: {},
  };
}
const owner = () => callerFor(ownerId, "owner");
const admin = (principal: Partial<McpPrincipal> = {}) =>
  callerFor(adminId, "admin", principal);
const member = (principal: Partial<McpPrincipal> = {}) =>
  callerFor(memberId, "member", principal);

/** The audit rows are written after the response; wait for them. */
async function settle(): Promise<void> {
  await Promise.all(
    hoisted.waitUntil.mock.calls.map(([task]) => Promise.resolve(task)),
  );
}

type Answer =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }
  | { ok: false; unknown: true; message: string };

/** Call a tool and read its answer: data, a tool error, or Unknown tool. */
async function call(
  name: string,
  args: Record<string, unknown>,
  as: McpCaller,
): Promise<Answer> {
  const response = await serveGatewayMcp(
    new Request(`${GATEWAY}/mcp`, {
      method: "POST",
      headers: {
        host: "gateway.example.com",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args, _meta: MODERN_META },
      }),
    }),
    as,
  );
  const text = await response.text();
  said.push(text);
  const body = JSON.parse(text) as {
    result?: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: { message: string };
  };
  await settle();
  if (body.error) {
    return { ok: false, unknown: true, message: body.error.message };
  }
  const result = body.result!;
  if (result.isError) {
    return { ok: false, error: result.content[0]?.text ?? "" };
  }
  return { ok: true, data: result.structuredContent ?? {} };
}

/** The answer's data, failing the test on a refusal. */
async function data(
  name: string,
  as: McpCaller,
  args: Record<string, unknown> = {},
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
  if (answer.ok) throw new Error(`${name} answered`);
  return "error" in answer ? answer.error : answer.message;
}

/** The sign-in id inside the link a start answered. */
function signInIdOf(url: unknown): string {
  return new URL(String(url)).searchParams.get("cliKey")!;
}

/** Start, approve in Composio, finish: the linked answer and the sign-in id. */
async function link(as: McpCaller) {
  const started = await data(LINK, as);
  const signInId = signInIdOf(started["url"]);
  composio.approve(signInId);
  const finished = await data(FINISH, as);
  expect(finished["state"]).toBe("linked");
  return { started, signInId, finished };
}

/** A connection the person made through Composio to GitHub, which crm may use. */
async function githubThroughComposio(userId: string) {
  const person = { organizationId, providerId: "github-oauth", userId };
  await ProviderConnectionRepository.upsertComposio(
    {
      ...person,
      appRowId: crmRowId,
      accounts: [{ service: "github", id: "ca_0", account: "brave-otter" }],
    },
    hoisted.env as { BETTER_AUTH_SECRET?: string },
  );
  await ProviderAppAccessRepository.allow({
    ...person,
    appRowId: crmRowId,
    scopes: ["repo"],
  });
}

const NOT_LINKED = {
  composio: "on",
  linked: false,
  account: null,
  providers: null,
  next: "Composio isn't linked. everyapp_provider_composio_link starts linking; the person approves a sign-in at Composio.",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  // An app that lists GitHub, whose client nobody set on this gateway.
  const plan = await deployLiveApp(db, {
    organizationId,
    appSlug: "crm",
    name: "CRM",
    manifest: {
      id: "crm",
      name: "CRM",
      capabilities: {
        "github-oauth": { scopes: ["repo"], why: "Lists repositories." },
      },
    },
    deployerUserId: ownerId,
    appBaseDomain: "apps.example.com",
  });
  crmRowId = plan.app.id;
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  clearOrgContextCacheForTests();
  resetAppSetupCacheForTests();
  resetGatewayProvidersForTests();
  resetToolBusForTests();
  said = [];
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...line: unknown[]) => {
      logged.push(line.map(String).join(" "));
    });
  }
  composio = fakeComposio();
  composio.state.accounts = [{ slug: "github", wordId: "brave-otter" }];
  // The tools take no `fetch`: the fake stands where the network would
  // be, so nothing here reaches Composio.
  vi.stubGlobal("fetch", (request: Request) => composio.fetch(request));
  // An owner turned Composio on. The tests of the switch turn it themselves.
  await OrgSettingsRepository.setComposio({
    organizationId,
    on: true,
    updatedBy: ownerId,
  });
});

describe("the organization's Composio switch on /mcp", () => {
  it("is an owner's or admin's with a read & write connection: a member and a read-only admin find the tool unknown", async () => {
    for (const as of [member(), admin({ access: "read" })]) {
      expect(await call(SWITCH, { on: false }, as)).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${SWITCH}`,
      });
    }
    expect(await OrgSettingsRepository.isComposioOn(organizationId)).toBe(true);

    expect(await data(SWITCH, admin(), { on: false })).toEqual({
      composio: "off",
      changed: true,
      removed: { links: 0, connections: 0 },
    });
    expect((await data("everyapp_workspace_show", admin()))["composio"]).toBe(
      "off",
    );
    // While it is off nobody links, and the status says who turns it on.
    expect(await refusal(LINK, {}, member())).toMatch(/^COMPOSIO_OFF: /);
    expect(await data(STATUS, member())).toEqual({
      composio: "off",
      linked: false,
      account: null,
      providers: null,
      next: "Composio is off for this organization. An owner or admin turns it on with everyapp_workspace_composio.",
    });

    expect(await data(SWITCH, owner(), { on: true })).toEqual({
      composio: "on",
      changed: true,
      removed: { links: 0, connections: 0 },
    });
    expect(await data(SWITCH, owner(), { on: true })).toMatchObject({
      composio: "on",
      changed: false,
    });
    expect((await data("everyapp_workspace_show", owner()))["composio"]).toBe(
      "on",
    );
  });

  it("is turned off only with confirm while a link or a connection through Composio would be deleted, and the refusal says how many", async () => {
    await link(member());
    await link(owner());
    await githubThroughComposio(memberId);

    for (const args of [{ on: false }, { on: false, confirm: false }]) {
      expect(await refusal(SWITCH, args, admin())).toBe(
        "INVALID_INPUT: Turning Composio off deletes 2 links and 1 connection made through it; confirm: true is required, and this cannot be undone",
      );
    }
    // Nothing was deleted, and it is still on.
    expect(await db.select().from(composioLinks)).toHaveLength(2);
    expect(await db.select().from(providerConnections)).toHaveLength(1);
    expect(await OrgSettingsRepository.isComposioOn(organizationId)).toBe(true);

    expect(await data(SWITCH, admin(), { on: false, confirm: true })).toEqual({
      composio: "off",
      changed: true,
      removed: { links: 2, connections: 1 },
    });
    expect(await db.select().from(composioLinks)).toEqual([]);
    expect(await db.select().from(providerConnections)).toEqual([]);
    expect(await db.select().from(providerAppAccess)).toEqual([]);
  });

  it("is turned off without confirm while a sign-in is only waiting: nothing a person made would go", async () => {
    await data(LINK, member());
    expect(await data(SWITCH, admin(), { on: false })).toEqual({
      composio: "off",
      changed: true,
      removed: { links: 0, connections: 0 },
    });
    expect(await db.select().from(composioLinkRequests)).toEqual([]);
  });
});

describe("the Composio link tools on /mcp", () => {
  it("link a member's own Composio, show it, and unlink it, never answering with the key or the sign-in id", async () => {
    expect(await data(STATUS, member())).toEqual(NOT_LINKED);

    const started = await data(LINK, member());
    const signInId = signInIdOf(started["url"]);
    // The start answers the page to open and when it stops working.
    expect(started).toEqual({
      url: `https://dashboard.composio.dev/?cliKey=${signInId}`,
      expiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      next: "Give this link to the person this connection acts as, to open and approve in their browser, and to nobody else. Then call everyapp_provider_composio_link_finish every couple of seconds until it answers linked or expired.",
    });
    expect(Date.parse(String(started["expiresAt"]))).toBeGreaterThan(
      Date.now(),
    );
    // What the start said is set aside: nothing after it may repeat it.
    const afterStart = said.length;

    expect(await data(FINISH, member())).toEqual({
      state: "waiting",
      next: "Not approved yet. Call everyapp_provider_composio_link_finish again in a couple of seconds.",
    });

    composio.approve(signInId);
    const linked = (connected: boolean) => ({
      composio: "on",
      linked: true,
      account: "alex@example.com",
      providers: [
        {
          provider: "github-oauth",
          providerName: "GitHub",
          services: [{ name: "GitHub", accounts: ["brave-otter"] }],
          connected,
        },
      ],
      next: "Linking added no connection. An account here becomes the person's connection when an app asks for it and they say yes, on the Gateway's page in a browser: they open the app and select Connect. everyapp_provider_connections lists the connections made, with `via`.",
    });
    expect(await data(FINISH, member())).toEqual({
      state: "linked",
      ...linked(false),
    });
    // Linking added no connection.
    expect(await db.select().from(providerConnections)).toEqual([]);
    // The status reads the accounts at Composio on every call.
    const before = composio.state.requests.length;
    expect(await data(STATUS, member())).toEqual(linked(false));
    expect(composio.state.requests.length).toBeGreaterThan(before);
    // Once they use the account in an app, the status says so.
    await githubThroughComposio(memberId);
    expect(await data(STATUS, member())).toEqual(linked(true));

    // A second start is refused while the link stands.
    expect(await refusal(LINK, {}, member())).toBe(
      "COMPOSIO_ALREADY_LINKED: Composio is already linked. Unlink it first.",
    );

    expect(await data(UNLINK, member())).toEqual({
      removed: true,
      next: "Every connection this person made through Composio is gone, so their apps stopped using those accounts. The key stays valid at Composio until the person revokes it there.",
    });
    expect(await db.select().from(composioLinks)).toEqual([]);
    expect(await db.select().from(providerConnections)).toEqual([]);
    expect(await db.select().from(providerAppAccess)).toEqual([]);
    expect(await data(STATUS, member())).toEqual(NOT_LINKED);
    // Nothing to unlink and nothing waiting: both say so, neither fails.
    expect(await data(UNLINK, member())).toEqual({
      removed: false,
      next: "Composio wasn't linked.",
    });
    expect(await data(FINISH, member())).toEqual({
      state: "expired",
      next: "The sign-in ran out, or none was started. everyapp_provider_composio_link starts another.",
    });

    // The key is in no answer and no log line; the sign-in id is in the
    // start's answer alone.
    const everything = [...said, ...logged].join("\n");
    expect(everything).not.toContain(composio.state.key);
    expect(everything).not.toContain("uak_");
    expect(said[afterStart - 1]).toContain(signInId);
    const afterTheStart = said.slice(afterStart).join("\n");
    expect(afterTheStart).not.toContain(signInId);
    expect(afterTheStart).not.toContain("cliKey");
    expect(said.slice(0, afterStart - 1).join("\n")).not.toContain("cliKey");
    expect(logged.join("\n")).not.toContain(signInId);
  });

  it("act on the caller's own link, whatever their role", async () => {
    const { signInId } = await link(member());
    await githubThroughComposio(memberId);
    // The owner and the admin see their own link, which is none.
    expect(await data(STATUS, owner())).toEqual(NOT_LINKED);
    expect(await data(STATUS, admin())).toEqual(NOT_LINKED);
    // Neither finds the member's sign-in or drops the member's link.
    expect(await data(FINISH, owner())).toMatchObject({ state: "expired" });
    expect(await data(UNLINK, owner())).toMatchObject({ removed: false });
    expect(await data(UNLINK, admin())).toMatchObject({ removed: false });
    expect(await data(STATUS, member())).toMatchObject({
      linked: true,
      account: "alex@example.com",
    });
    expect(await db.select().from(composioLinks)).toMatchObject([
      { organizationId, userId: memberId },
    ]);
    expect(await db.select().from(providerConnections)).toHaveLength(1);

    // An owner and an admin link their own the same way.
    for (const as of [owner(), admin()]) {
      const linked = await link(as);
      expect(linked.finished).toMatchObject({
        linked: true,
        account: "alex@example.com",
      });
      expect(linked.signInId).not.toBe(signInId);
    }
    expect(
      (await db.select().from(composioLinks)).map((row) => row.userId).sort(),
    ).toEqual([ownerId, adminId, memberId].sort());
    expect(said.join("\n")).not.toContain(composio.state.key);
  });

  it("take no argument: nothing names a key, a sign-in or another person", async () => {
    await link(member());
    for (const [name, args] of [
      [STATUS, { user: "member@example.com" }],
      [LINK, { key: "uak_x" }],
      [FINISH, { id: "5b2f1c1e-0000-4000-8000-00000000000a" }],
      [UNLINK, { user: "member@example.com" }],
    ] as const) {
      expect(await refusal(name, args, owner())).toContain(
        `Invalid arguments for ${name}`,
      );
    }
    expect(await db.select().from(composioLinks)).toHaveLength(1);
    expect(await db.select().from(composioLinkRequests)).toHaveLength(0);
  });

  it("give a read-only connection the status alone", async () => {
    await link(member());
    const readOnly = member({ access: "read" });
    expect(await data(STATUS, readOnly)).toMatchObject({
      linked: true,
      account: "alex@example.com",
    });
    for (const name of [LINK, FINISH, UNLINK]) {
      expect(await call(name, {}, readOnly)).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
    }
    expect(await db.select().from(composioLinks)).toHaveLength(1);
  });

  it("answer a sign-in that ran out as expired, and a new start replaces one that is waiting", async () => {
    const first = await data(LINK, member());
    const second = await data(LINK, member());
    expect(signInIdOf(second["url"])).not.toBe(signInIdOf(first["url"]));
    expect(await db.select().from(composioLinkRequests)).toHaveLength(1);
    // Approving the replaced sign-in links nothing.
    composio.approve(signInIdOf(first["url"]));
    expect(await data(FINISH, member())).toMatchObject({ state: "waiting" });
    composio.expire(signInIdOf(second["url"]));
    expect(await data(FINISH, member())).toMatchObject({ state: "expired" });
    expect(await db.select().from(composioLinkRequests)).toHaveLength(0);
    expect(await data(STATUS, member())).toEqual(NOT_LINKED);
  });

  it("refuse with the service's code when Composio can't be reached, never its text, and say when what is in a Composio isn't known", async () => {
    await link(owner());
    composio.state.intercept = () => composio.refusal(500, "Internal", 9000);
    expect(await refusal(LINK, {}, member())).toBe(
      "COMPOSIO_UNAVAILABLE: Composio could not be reached. Try again.",
    );
    expect(await data(STATUS, owner())).toEqual({
      composio: "on",
      linked: true,
      account: "alex@example.com",
      providers: null,
      next: "Composio didn't answer, so what is in this Composio isn't known. Call again.",
    });
    expect(said.join("\n")).not.toContain("A message nothing may rely on");
  });
});
