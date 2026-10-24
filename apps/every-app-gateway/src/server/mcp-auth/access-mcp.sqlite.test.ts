/**
 * The gateway's own /mcp behind Cloudflare Access's Managed OAuth, in
 * process: the real worker entry (server.ts) on SQLite, real SDK apps behind
 * their service bindings, and a mock Access whose signed assertions arrive
 * in `Cf-Access-Jwt-Assertion`, as Access adds them to every request it lets
 * through. Access only says who the person is: the gateway serves them as
 * the account the outer ring linked for that identity, with every app they
 * can use, and refuses everyone else by reason. Where the assertion is
 * missing, forged, a service token's, for the apps' application, or where
 * the outer ring is off, /mcp answers as it always has (its own OAuth server
 * and personal tokens).
 */
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

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
  background: [] as Promise<unknown>[],
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: (task: Promise<unknown>) => {
    hoisted.background.push(task);
  },
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => hoisted.testDb.current }));
// Nothing here is a browser with a session: Better Auth is never asked.
vi.mock("@/auth", () => ({
  createAuth: vi.fn(),
  auth: { api: { getSession: async () => null } },
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: async () => new Response("control plane") },
}));

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  defineTools,
  everyApp,
  type EveryAppUser,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import { clearJwksClientsForTests } from "@/auth/cloudflare-access/jwt";
import {
  accounts,
  mcpConnections,
  mcpToolCalls,
  members,
  organizations,
  sessions,
  userAccessTokens,
  users,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { AppAccessService } from "@/server/services/AppAccessService";
import { UserPatService } from "@/server/services/UserPatService";
import {
  clearCatalogSyncClaimsForTests,
  syncAppTools,
} from "@/server/toolbus/catalog-sync";
import { resetAppHostMcpForTests } from "@/server/toolbus/app-host-mcp";
import { listenIntervalsForTests } from "@/server/toolbus/runtime";
import { createKvFake } from "@/test/kv-fake";
import {
  APPS_AUD,
  createMockAccess,
  MOCK_ACCESS_ENV,
  type MockAccess,
  type MockIdentity,
} from "@/test/mock-access";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

const GATEWAY = "https://gateway.example.com";
const HOST = "gateway.example.com";
const OWNER_EMAIL = "owner@example.com";
const MEMBER_EMAIL = "member@example.com";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

function objectInput<T>(
  properties: Record<string, unknown> = {},
  required: string[] = [],
): PlainToolSchema<T> {
  return {
    jsonSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    validate: (value) => ({ value: value as T }),
  };
}

/** The users the apps' tool handlers were called as. */
const seen: EveryAppUser[] = [];

function todoApp(publicKeyPem: string) {
  return everyApp(
    async () => new Response("todo page"),
    { id: "todo" },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        list_todos: {
          description: "List todos.",
          risk: "read",
          input: objectInput(),
          handler: (_input, { user }) => {
            seen.push(user);
            return { todos: [] };
          },
        },
        create_todo: {
          description: "Create a todo.",
          risk: "write",
          input: objectInput<{ title: string }>({ title: { type: "string" } }, [
            "title",
          ]),
          handler: ({ title }, { user }) => {
            seen.push(user);
            return { todo: { id: "t1", title } };
          },
        },
      }),
    },
  );
}

/** An app with one read tool, `ping`. */
function pingApp(id: string, publicKeyPem: string) {
  return everyApp(
    async () => new Response(`${id} page`),
    { id },
    {
      publicKeys: [publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        ping: {
          description: "Ping.",
          risk: "read",
          input: objectInput(),
          handler: () => "pong",
        },
      }),
    },
  );
}

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let access: MockAccess;
let orgId: string;
let ownerId: string;
let memberId: string;
let todoRowId: string;

/** Everything the requests scheduled after their responses. */
async function settle(): Promise<void> {
  while (hoisted.background.length) {
    await Promise.all(hoisted.background.splice(0));
  }
}

function bindApp(binding: string, app: ReturnType<typeof everyApp>) {
  // Deployed as everyAppWorker() does: the Worker's name is its audience.
  const appEnv = { EVERYAPP_AUDIENCE: binding.slice("APP__".length) };
  hoisted.env[binding] = {
    fetch: async (request: Request) =>
      app.fetch(request, appEnv, {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext),
  };
}

/** An app live in `organizationId`, its tools snapshotted; returns its row id. */
async function deployApp(
  organizationId: string,
  deployerUserId: string,
  appSlug: string,
  worker: ReturnType<typeof everyApp>,
): Promise<string> {
  const name = appSlug[0]!.toUpperCase() + appSlug.slice(1);
  const { app } = await deployLiveApp(db, {
    organizationId,
    deployerUserId,
    appBaseDomain: HOST,
    isInstallOrganization: false,
    appSlug,
    name,
    description: name,
    manifest: { id: appSlug, name },
  });
  bindApp(`APP__${app.workerName}`, worker);
  await syncAppTools({
    rowId: app.id,
    organizationId,
    appSlug,
    hostname: app.hostname!,
    workerName: app.workerName!,
    tier: "service_binding",
    versionId: app.versionId,
  });
  return app.id;
}

/** Link an Access identity to a user, as the outer ring does at sign-in. */
async function link(email: string, userId: string): Promise<void> {
  await db.insert(accounts).values({
    id: `account-${email}`,
    providerId: "cloudflare-access",
    accountId: email,
    userId,
    updatedAt: new Date(),
  });
}

/** A POST to the gateway's /mcp with whatever headers the case needs. */
function mcp(
  headers: Record<string, string>,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  const all = new Headers({
    host: HOST,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...(name ? { "mcp-name": name } : {}),
    ...headers,
  });
  return server.fetch(
    new Request(`${GATEWAY}/mcp`, {
      method: "POST",
      headers: all,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, _meta: MODERN_META },
      }),
    }),
  );
}

/** The `Cf-Access-Jwt-Assertion` the outer ring adds for this person. */
async function vouched(
  identity: MockIdentity,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  return {
    "cf-access-jwt-assertion": await access.assertion(identity),
    ...extra,
  };
}

async function toolNames(headers: Record<string, string>): Promise<string[]> {
  const response = await mcp(headers, "tools/list");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return body.result.tools.map((tool) => tool.name);
}

async function callTool(
  headers: Record<string, string>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const response = await mcp(headers, "tools/call", { name, arguments: args });
  await settle();
  return {
    status: response.status,
    body: (await response.json()) as {
      result?: { content: { text: string }[]; structuredContent?: unknown };
      error?: { code: number; message: string };
    },
  };
}

/** What /mcp answered when it took the request as one of its own. */
async function refusedBy(response: Response) {
  return {
    status: response.status,
    authenticate: response.headers.get("www-authenticate"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** The gateway's own 401, as /mcp answers a request with no credential. */
async function expectUnauthenticated(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toMatch(/^Bearer /);
  expect(await db.select().from(mcpToolCalls)).toEqual([]);
}

async function pat(userId = ownerId, organizationId = orgId): Promise<string> {
  const { plaintext } = await UserPatService.create({
    userId,
    organizationId,
    name: "a script",
  });
  return plaintext;
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
});

afterEach(async () => {
  await settle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    // D1-shaped, so the registry hands it to the (mocked) drizzle driver.
    DB: { prepare: () => undefined },
    OAUTH_KV: createKvFake().kv,
    ...MOCK_ACCESS_ENV.outerRing,
    // A separate Access application on the apps' hosts.
    CLOUDFLARE_ACCESS_APPS_AUD: APPS_AUD,
  });
  hoisted.background.length = 0;
  seen.length = 0;
  resetAppHostMcpForTests();
  clearCatalogSyncClaimsForTests();
  clearHostnameCacheForTests();
  clearJwksClientsForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  db = await createTestDb();
  hoisted.testDb.current = db;
  access = await createMockAccess();
  vi.stubGlobal("fetch", access.fetch);

  orgId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, {
    organizationId: orgId,
    role: "owner",
    email: OWNER_EMAIL,
  });
  memberId = await seedMember(db, {
    organizationId: orgId,
    role: "member",
    email: MEMBER_EMAIL,
  });
  todoRowId = await deployApp(
    orgId,
    ownerId,
    "todo",
    todoApp(keys.publicKeyPem),
  );
  await deployApp(orgId, ownerId, "notes", pingApp("notes", keys.publicKeyPem));
  // Both apps are private to the owner until shared: todo with the member.
  await AppAccessService.updateAccessForApp(
    { orgId, userId: ownerId, role: "owner" },
    todoRowId,
    [ownerId, memberId],
  );
  // The owner and the member signed in through Access once in a browser.
  await link(OWNER_EMAIL, ownerId);
  await link(MEMBER_EMAIL, memberId);
});

describe("a Cloudflare Access assertion on the gateway's /mcp (SQLite)", () => {
  it("serves a linked member every app they can use, read and write, as the person Access vouches for", async () => {
    const headers = await vouched({ email: MEMBER_EMAIL });
    expect(await toolNames(headers)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "todo_create_todo",
      "todo_list_todos",
    ]);

    const created = await callTool(headers, "todo_create_todo", {
      title: "buy milk",
    });
    expect(created.status).toBe(200);
    expect(JSON.parse(created.body.result!.content[0]!.text)).toEqual({
      todo: { id: "t1", title: "buy milk" },
    });
    expect(seen.at(-1)).toMatchObject({
      id: memberId,
      email: MEMBER_EMAIL,
      orgId,
      channel: "mcp",
      actor: { sub: `access:${MEMBER_EMAIL}` },
      toolCall: { name: "create_todo" },
    });
    const [audit] = await db.select().from(mcpToolCalls);
    // An Access caller has no connection row to name the AI app, so the
    // row keeps what the client called itself in the handshake.
    expect(audit).toMatchObject({
      surface: "gateway",
      credentialKind: "access",
      credentialId: MEMBER_EMAIL,
      clientName: null,
      clientInfo: "test 1",
      appSlug: "todo",
      toolName: "todo_create_todo",
      risk: "write",
      decision: "allowed",
      outcome: "ok",
    });

    const whoami = await callTool(headers, "everyapp_whoami");
    expect(whoami.body.result!.structuredContent).toEqual({
      user: { email: MEMBER_EMAIL, role: "member" },
      organization: { id: orgId, name: "acme" },
      connection: { kind: "access", access: "read & write" },
      apps: ["todo"],
    });
    // The owner, who can use both apps, sees both.
    expect(await toolNames(await vouched({ email: OWNER_EMAIL }))).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "notes_ping",
      "todo_create_todo",
      "todo_list_todos",
    ]);
  });

  it("ignores Access's own opaque bearer token sent alongside the assertion", async () => {
    const headers = await vouched(
      { email: MEMBER_EMAIL },
      { authorization: "Bearer oauth:abc" },
    );
    expect(await toolNames(headers)).toContain("todo_list_todos");
    const call = await callTool(headers, "todo_list_todos");
    expect(call.status).toBe(200);
    expect(await db.select().from(mcpToolCalls)).toMatchObject([
      { credentialKind: "access", credentialId: MEMBER_EMAIL },
    ]);
  });

  it("refuses an identity no account is linked to, even one whose email a user has", async () => {
    await seedMember(db, { organizationId: orgId, email: "carol@example.com" });
    for (const email of ["carol@example.com", "nobody@example.com"]) {
      const response = await mcp(await vouched({ email }), "tools/list");
      expect(await refusedBy(response), email).toMatchObject({
        status: 403,
        body: {
          error: "forbidden",
          reason: "not_connected",
          message: expect.stringContaining("browser"),
        },
      });
    }
    expect(await db.select().from(accounts)).toHaveLength(2);
    expect(await db.select().from(members)).toHaveLength(3);
  });

  it("refuses a deactivated user and a suspended organization", async () => {
    await db.update(users).set({ banned: true }).where(eq(users.id, memberId));
    const deactivated = await mcp(
      await vouched({ email: MEMBER_EMAIL }),
      "tools/list",
    );
    expect(await refusedBy(deactivated)).toMatchObject({
      status: 403,
      body: { error: "forbidden", reason: "account_deactivated" },
    });

    await db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, orgId));
    const suspended = await mcp(
      await vouched({ email: OWNER_EMAIL }),
      "tools/list",
    );
    expect(await refusedBy(suspended)).toMatchObject({
      status: 403,
      body: { error: "forbidden", reason: "organization_suspended" },
    });
  });

  it("ignores an assertion of the apps' Access application", async () => {
    const response = await mcp(
      await vouched({ email: OWNER_EMAIL, claims: { aud: [APPS_AUD] } }),
      "tools/list",
    );
    await expectUnauthenticated(response);
  });

  it("ignores an assertion that doesn't verify, and then takes a personal token as ever", async () => {
    const now = Math.floor(Date.now() / 1000);
    const other = await createMockAccess();
    const noEmail: MockIdentity = {
      email: "",
      claims: { common_name: "a-service-token", sub: "service-token-id" },
    };
    const ignored: Record<string, Promise<Record<string, string>>> = {
      expired: vouched({ email: OWNER_EMAIL, claims: { exp: now - 3600 } }),
      "wrong issuer": vouched({
        email: OWNER_EMAIL,
        claims: { iss: "https://other.cloudflareaccess.com" },
      }),
      "another key": other.assertion({ email: OWNER_EMAIL }).then((jwt) => ({
        "cf-access-jwt-assertion": jwt,
      })),
      "an org token": vouched({ email: OWNER_EMAIL, claims: { type: "org" } }),
      "no email": vouched(noEmail),
      garbage: Promise.resolve({ "cf-access-jwt-assertion": "not-a-jwt" }),
    };
    for (const [why, headers] of Object.entries(ignored)) {
      const response = await mcp(await headers, "tools/list");
      expect(response.status, why).toBe(401);
      expect(response.headers.get("www-authenticate"), why).toMatch(/^Bearer /);
    }
    expect(await db.select().from(mcpToolCalls)).toEqual([]);

    // A script through a Service Auth policy: Access's service-token
    // assertion vouches for nobody, so its personal token is what counts.
    const token = await pat();
    const served = await vouched(noEmail, { authorization: `Bearer ${token}` });
    expect(await toolNames(served)).toContain("todo_create_todo");
    await callTool(served, "todo_list_todos");
    expect(await db.select().from(mcpToolCalls)).toMatchObject([
      { credentialKind: "pat" },
    ]);
  });

  it("serves the person Access vouches for even when a valid personal token comes along", async () => {
    const token = await pat();
    const headers = await vouched(
      { email: MEMBER_EMAIL },
      { authorization: `Bearer ${token}` },
    );
    await callTool(headers, "todo_list_todos");
    expect(await db.select().from(mcpToolCalls)).toMatchObject([
      { credentialKind: "access", credentialId: MEMBER_EMAIL },
    ]);
    expect(seen.at(-1)?.actor).toEqual({ sub: `access:${MEMBER_EMAIL}` });
    const [row] = await db.select().from(userAccessTokens);
    expect(row?.lastUsedAt).toBeNull();
  });

  it("ignores the assertion where the outer ring isn't configured, or the gateway is hosted", async () => {
    const headers = await vouched({ email: OWNER_EMAIL });
    for (const name of Object.keys(MOCK_ACCESS_ENV.outerRing)) {
      delete hoisted.env[name];
    }
    delete hoisted.env["CLOUDFLARE_ACCESS_APPS_AUD"];
    await expectUnauthenticated(await mcp(headers, "tools/list"));

    Object.assign(hoisted.env, MOCK_ACCESS_ENV.outerRing, {
      CLOUDFLARE_ACCESS_APPS_AUD: APPS_AUD,
      GATEWAY_DEPLOYMENT_MODE: "hosted",
    });
    await expectUnauthenticated(await mcp(headers, "tools/list"));
  });

  it("never reads the CF_Authorization cookie", async () => {
    const assertion = await access.assertion({ email: OWNER_EMAIL });
    const response = await mcp(
      { cookie: `CF_Authorization=${assertion}` },
      "tools/list",
    );
    await expectUnauthenticated(response);
  });

  it("refuses a cross-site browser's request before looking at who it is", async () => {
    // Behind Managed OAuth, Access lets a browser's cookie-carrying request
    // through with the assertion added, so the Origin rule the ToolBus
    // applies to every request runs first here, ahead of any lookup.
    const forbidden = {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden: origin not allowed." },
      id: null,
    };
    // An identity nobody is linked to: refused for its origin, not as
    // not_connected, so the account was never looked up.
    const stranger = await mcp(
      await vouched(
        { email: "nobody@example.com" },
        { origin: "https://evil.example" },
      ),
      "tools/list",
    );
    expect(stranger.status).toBe(403);
    expect(await stranger.json()).toEqual(forbidden);

    // A linked member's tool call from another site: nothing runs, nothing
    // is audited.
    const call = await mcp(
      await vouched(
        { email: MEMBER_EMAIL },
        { origin: "https://evil.example" },
      ),
      "tools/call",
      { name: "todo_create_todo", arguments: { title: "from elsewhere" } },
    );
    expect(call.status).toBe(403);
    expect(await call.json()).toEqual(forbidden);
    await settle();
    expect(seen).toEqual([]);
    expect(await db.select().from(mcpToolCalls)).toEqual([]);

    // The gateway's own pages, and an origin in MCP_ALLOWED_ORIGINS, may.
    expect(
      await toolNames(
        await vouched({ email: MEMBER_EMAIL }, { origin: GATEWAY }),
      ),
    ).toContain("todo_list_todos");
    hoisted.env["MCP_ALLOWED_ORIGINS"] = "http://localhost:6274";
    expect(
      await toolNames(
        await vouched(
          { email: MEMBER_EMAIL },
          { origin: "http://localhost:6274" },
        ),
      ),
    ).toContain("todo_list_todos");
  });

  it("acts in the organization the person's browser is in, among several", async () => {
    const otherOrgId = await seedOrganization(db, "beta");
    await db.insert(members).values({
      id: "member-owner-beta",
      organizationId: otherOrgId,
      userId: ownerId,
      role: "owner",
      createdAt: new Date(),
    });
    await deployApp(
      otherOrgId,
      ownerId,
      "wiki",
      pingApp("wiki", keys.publicKeyPem),
    );
    const headers = await vouched({ email: OWNER_EMAIL });

    // No live session says which: nothing is guessed.
    const unresolved = await mcp(headers, "tools/list");
    expect(await refusedBy(unresolved)).toMatchObject({
      status: 403,
      body: {
        error: "forbidden",
        reason: "organization_unresolved",
        message: expect.stringContaining("browser"),
      },
    });
    // An expired session says nothing either.
    await db.insert(sessions).values({
      id: "session-old",
      token: "token-old",
      userId: ownerId,
      expiresAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 120_000),
      activeOrganizationId: otherOrgId,
    });
    expect((await mcp(headers, "tools/list")).status).toBe(403);

    await db.insert(sessions).values({
      id: "session-live",
      token: "token-live",
      userId: ownerId,
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
      activeOrganizationId: otherOrgId,
    });
    expect(await toolNames(headers)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "wiki_ping",
    ]);
    const whoami = await callTool(headers, "everyapp_whoami");
    expect(whoami.body.result!.structuredContent).toMatchObject({
      organization: { id: otherOrgId, name: "beta" },
      apps: ["wiki"],
    });

    // The browser moved to acme: so do the tool calls.
    await db
      .update(sessions)
      .set({ activeOrganizationId: orgId, updatedAt: new Date() })
      .where(eq(sessions.id, "session-live"));
    expect(await toolNames(headers)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "notes_ping",
      "todo_create_todo",
      "todo_list_todos",
    ]);
  });

  describe("a held subscriptions/listen stream", () => {
    // Polls far apart enough that a re-read never runs past one (which
    // would end the stream by itself), and a life longer than the test.
    beforeEach(() => {
      listenIntervalsForTests.pollMs = 100;
      listenIntervalsForTests.maxMs = 10_000;
      resetAppHostMcpForTests();
    });
    afterEach(() => {
      delete listenIntervalsForTests.pollMs;
      delete listenIntervalsForTests.maxMs;
      resetAppHostMcpForTests();
    });

    /**
     * Open the stream, see it acknowledged and kept alive twice (so the
     * re-reads finish within a poll), apply `change`, and expect the
     * stream to complete and close: the person no longer stands as they
     * did.
     */
    async function expectEndedBy(
      headers: Record<string, string>,
      change: () => Promise<unknown>,
    ): Promise<void> {
      const listen = await mcp(headers, "subscriptions/listen", {
        notifications: { toolsListChanged: true },
      });
      expect(listen.status).toBe(200);
      expect(listen.headers.get("content-type")).toBe("text/event-stream");
      const reader = listen.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const next = async (marker: string, times = 1): Promise<void> => {
        while (text.split(marker).length <= times) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`stream ended before ${marker}`);
          text += decoder.decode(value, { stream: true });
        }
      };
      await next("notifications/subscriptions/acknowledged");
      await next(": keepalive", 2);
      expect(text).not.toContain('"resultType":"complete"');

      await change();
      await next('"resultType":"complete"');
      expect((await reader.read()).done).toBe(true);
    }

    it("ends once the person is deactivated", async () => {
      await expectEndedBy(await vouched({ email: MEMBER_EMAIL }), () =>
        db.update(users).set({ banned: true }).where(eq(users.id, memberId)),
      );
    });

    it("ends once the person is removed from the organization", async () => {
      await expectEndedBy(await vouched({ email: MEMBER_EMAIL }), () =>
        db.delete(members).where(eq(members.userId, memberId)),
      );
    });

    it("ends once the organization is suspended", async () => {
      await expectEndedBy(await vouched({ email: OWNER_EMAIL }), () =>
        db
          .update(organizations)
          .set({ status: "suspended" })
          .where(eq(organizations.id, orgId)),
      );
    });

    it("ends once the person's browser moved to another organization, the personal token alongside untouched", async () => {
      const otherOrgId = await seedOrganization(db, "beta");
      await db.insert(members).values({
        id: "member-owner-beta",
        organizationId: otherOrgId,
        userId: ownerId,
        role: "owner",
        createdAt: new Date(),
      });
      await db.insert(sessions).values({
        id: "session-live",
        token: "token-live",
        userId: ownerId,
        expiresAt: new Date(Date.now() + 600_000),
        updatedAt: new Date(),
        activeOrganizationId: orgId,
      });
      // A personal token along for the ride, still valid throughout: the
      // assertion is what is rechecked, so the token is never used, let
      // alone touched (were the token rechecked instead, the stream would
      // stay open).
      const token = await pat(ownerId);
      await expectEndedBy(
        await vouched(
          { email: OWNER_EMAIL },
          { authorization: `Bearer ${token}` },
        ),
        () =>
          db
            .update(sessions)
            .set({ activeOrganizationId: otherOrgId, updatedAt: new Date() })
            .where(eq(sessions.id, "session-live")),
      );

      expect(await db.select().from(mcpConnections)).toEqual([]);
      const [row] = await db.select().from(userAccessTokens);
      expect(row?.lastUsedAt).toBeNull();
    });
  });
});
