/**
 * App-host /mcp end to end against a migrated SQLite database: a real
 * personal access token, the real authenticator and registry, the perimeter,
 * the catalog snapshot in D1, the ToolBus, and a real SDK app (`everyApp` +
 * `defineTools`) behind its service binding.
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
  env: {
    GATEWAY_URL: "https://gateway.example.com",
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
import { eq, sql } from "drizzle-orm";
import {
  handleGatewayRequest,
  type AuthenticatedSession,
  type GatewayDeps,
  type ParsedHost,
  type SessionAuthenticator,
} from "@every-app/perimeter";
import {
  IDENTITY_HEADER,
  SYSTEM_HEADER,
  TOOLS_CALL_PATH,
} from "@every-app/sdk/internal";
import {
  ToolError,
  defineTools,
  everyApp,
  type EveryAppUser,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import {
  apps,
  appToolCatalogs,
  appTools,
  mcpToolCalls,
  userAccessTokens,
  users,
} from "@/db/schema";
import { createProdAuthenticator } from "@/perimeter/betterAuthAuthenticator";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { AppService } from "@/server/services/AppService";
import { UserPatService } from "@/server/services/UserPatService";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  clearCatalogSyncClaimsForTests,
  syncAppTools,
  type SyncableApp,
} from "./catalog-sync";
import { resetAppHostMcpForTests, serveAppHostMcp } from "./app-host-mcp";

const HOST = "todo-acme.gateway.example.com";
// The Worker name the gateway assigns app todo in organization acme.
const WORKER = "every-acme-todo";
const BINDING = `APP__${WORKER}`;

function objectInput<T>(
  properties: Record<string, unknown>,
  required: string[],
  check: (value: Record<string, unknown>) => string | null = () => null,
): PlainToolSchema<T> {
  return {
    jsonSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    validate: (value) => {
      const problem = check(value as Record<string, unknown>);
      return problem
        ? { issues: [{ message: problem }] }
        : { value: value as T };
    },
  };
}

const seen: EveryAppUser[] = [];

function todoTools(extraTool = false) {
  return defineTools({
    list_todos: {
      description: "List the user's todos.",
      risk: "read",
      input: objectInput<Record<string, never>>({}, []),
      handler: (_input, { user }) => {
        seen.push(user);
        return { todos: [] };
      },
    },
    create_todo: {
      description: "Create a todo.",
      risk: "write",
      input: objectInput<{ title: string }>(
        { title: { type: "string", minLength: 1 } },
        ["title"],
      ),
      handler: ({ title }, { user }) => {
        seen.push(user);
        if (title === "taken") throw new ToolError("That todo already exists");
        return { todo: { id: "t1", title, completed: false } };
      },
    },
    delete_todo: {
      description: "Delete a todo forever.",
      risk: "destructive",
      input: objectInput<{ id: string }>({ id: { type: "string" } }, ["id"]),
      handler: () => "deleted",
    },
    ...(extraTool
      ? {
          archive_todos: {
            description: "Archive completed todos.",
            risk: "write" as const,
            input: objectInput<Record<string, never>>({}, []),
            handler: () => "archived",
          },
        }
      : {}),
  });
}

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let organizationId: string;
let ownerId: string;
let appRowId: string;
const appRequests: Request[] = [];

/** Deploy (or redeploy) the app Worker behind its binding. */
function deployApp(
  options: {
    extraTool?: boolean;
    contract?: boolean;
    /** How the catalog endpoint misbehaves, if it does. */
    catalog?: "broken" | "slow";
  } = {},
) {
  const worker = everyApp(
    async () => new Response("todo app page"),
    { id: "todo" },
    {
      publicKeys: [keys.publicKeyPem],
      issuer: "https://gateway.example.com",
      ...(options.contract === false
        ? {}
        : { tools: todoTools(options.extraTool) }),
    },
  );
  hoisted.env[BINDING] = {
    fetch: async (request: Request) => {
      appRequests.push(request.clone() as Request);
      if (options.contract === false && request.url.includes("/__everyapp/")) {
        // An app on SDK 0.2: everything needs an identity.
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      }
      if (request.url.endsWith("/__everyapp/tools/list")) {
        if (options.catalog === "broken") {
          return new Response("catalog broke", { status: 500 });
        }
        if (options.catalog === "slow") {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      return worker.fetch(request, {}, { waitUntil: () => undefined });
    },
  };
}

const SESSION_COOKIE = "every-app.session_token=owner-session";

/**
 * The production authenticator, except that the owner's browser session is
 * a fixed cookie instead of a Better Auth session row. Everything before
 * authentication (CSRF, the tools-path refusal) is the real perimeter.
 */
function authenticator(): SessionAuthenticator {
  const prod = createProdAuthenticator();
  return {
    async authenticate(request) {
      if (request.headers.has("authorization")) {
        return prod.authenticate(request);
      }
      if (request.headers.get("cookie") === SESSION_COOKIE) {
        return {
          sub: ownerId,
          email: "owner@example.com",
          orgId: organizationId,
          orgRole: "owner",
        } satisfies AuthenticatedSession;
      }
      return null;
    },
    hasAppAccess: (session, app) => prod.hasAppAccess(session, app),
  };
}

function gatewayDeps(): GatewayDeps {
  return {
    env: hoisted.env,
    registry: new DrizzleAppRegistry(db as never),
    authenticator: authenticator(),
    privateKeyPem: keys.privateKeyPem,
    issuer: "https://gateway.example.com",
    resolveApp: (host: ParsedHost, registry) =>
      registry.findByHostname(host.host),
    interceptMcp: serveAppHostMcp,
  };
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "2" },
};

function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  era: "modern" | "legacy" = "modern",
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  const headers: Record<string, string> = {
    host: HOST,
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "cf-ray": "ray-123",
  };
  if (era === "modern") {
    headers["mcp-protocol-version"] = "2026-07-28";
    headers["mcp-method"] = method;
    if (name) headers["mcp-name"] = name;
  } else if (method !== "initialize") {
    headers["mcp-protocol-version"] = "2025-06-18";
  }
  return handleGatewayRequest(
    new Request(`https://${HOST}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: era === "modern" ? { ...params, _meta: MODERN_META } : params,
      }),
    }),
    gatewayDeps(),
  );
}

/** POST (or another method) to the app host's /mcp with these headers. */
function mcpRaw(
  headers: Record<string, string>,
  body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  method = "POST",
): Promise<Response> {
  return handleGatewayRequest(
    new Request(`https://${HOST}/mcp`, {
      method,
      headers: {
        host: HOST,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...headers,
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
    gatewayDeps(),
  );
}

async function personalToken(
  scopes?: string[],
  options: { appRowId?: string } = {},
): Promise<string> {
  const { plaintext } = await UserPatService.create({
    userId: ownerId,
    organizationId,
    name: "claude code",
    scopes,
    appRowId: options.appRowId ?? null,
  });
  return plaintext;
}

const listCalls = () =>
  appRequests.filter(
    (r) => new URL(r.url).pathname === "/__everyapp/tools/list",
  ).length;

function auditLines(consoleLog: { mock: { calls: unknown[][] } }) {
  return consoleLog.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.includes('"evt":"mcp.tool_call"'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function syncable(): SyncableApp {
  return {
    rowId: appRowId,
    organizationId,
    appSlug: "todo",
    hostname: HOST,
    workerName: WORKER,
    tier: "service_binding",
    versionId: "todo-version",
  };
}

/**
 * Register an app and take it live, as `everyapp deploy` does: the CLI
 * registers it and records the uploaded version, then the gateway's first
 * request over the new binding activates it.
 */
async function deployLive(
  appSlug: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const { app } = await deployLiveApp(db, {
    organizationId,
    appSlug,
    name: String(manifest["name"] ?? appSlug),
    description: String(manifest["name"] ?? appSlug),
    manifest,
    deployerUserId: ownerId,
    appBaseDomain: "gateway.example.com",
    isInstallOrganization: false,
  });
  return app.id;
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
  hoisted.env.JWT_PRIVATE_KEY = keys.privateKeyPem;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  db = await createTestDb();
  hoisted.testDb.current = db;
  organizationId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, { organizationId, role: "owner" });
  appRowId = await deployLive("todo", { id: "todo", name: "Todos" });
  appRequests.length = 0;
  seen.length = 0;
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppHostMcpForTests();
  deployApp();
});

describe("catalog sync", () => {
  it("snapshots the app's tools with one invocation and a system token", async () => {
    const result = await syncAppTools(syncable());

    expect(result).toMatchObject({
      status: "ok",
      toolCount: 3,
      sdkVersion: "0.3.0",
      warnings: [],
    });
    expect(appRequests).toHaveLength(1);
    expect(appRequests[0]!.headers.get(SYSTEM_HEADER)).toBeTruthy();
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog).toMatchObject({
      appRowId,
      organizationId,
      status: "ok",
      toolCount: 3,
      catalogHash: result.catalogHash,
      lastError: null,
    });
    const tools = await db.select().from(appTools);
    expect(tools.map((tool) => [tool.name, tool.risk]).sort()).toEqual([
      ["create_todo", "write"],
      ["delete_todo", "destructive"],
      ["list_todos", "read"],
    ]);
  });

  it("never lets the system token call a tool, inside or outside", async () => {
    await syncAppTools(syncable());
    const systemToken = appRequests[0]!.headers.get(SYSTEM_HEADER)!;
    const appBinding = hoisted.env[BINDING] as {
      fetch(request: Request): Promise<Response>;
    };
    const call = (headers: Record<string, string>) =>
      appBinding.fetch(
        new Request(`https://${HOST}${TOOLS_CALL_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            v: 1,
            name: "list_todos",
            arguments: {},
            callId: "c1",
          }),
        }),
      );
    expect((await call({ [IDENTITY_HEADER]: systemToken })).status).toBe(401);
    expect((await call({ [SYSTEM_HEADER]: systemToken })).status).toBe(401);

    // From outside the gateway, the contract doesn't exist.
    const outside = await handleGatewayRequest(
      new Request(`https://${HOST}${TOOLS_CALL_PATH}`, {
        method: "POST",
        headers: {
          host: HOST,
          authorization: `Bearer ${await personalToken()}`,
          [SYSTEM_HEADER]: systemToken,
        },
        body: "{}",
      }),
      gatewayDeps(),
    );
    expect(outside.status).toBe(404);
  });

  it("marks apps without the contract unsupported and keeps a good snapshot on failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-12T12:00:00Z");
    vi.setSystemTime(t0);
    deployApp({ contract: false });
    await expect(syncAppTools(syncable())).resolves.toMatchObject({
      status: "unsupported",
    });
    expect(await db.select().from(appTools)).toEqual([]);
    const [unsupported] = await db.select().from(appToolCatalogs);
    expect(unsupported?.fetchedAt).toEqual(t0);

    // A failed attempt on a catalog that isn't serving records its time.
    vi.setSystemTime(t0.getTime() + 60_000);
    hoisted.env[BINDING] = {
      fetch: async () => new Response("down", { status: 500 }),
    };
    await syncAppTools(syncable());
    const [failed] = await db.select().from(appToolCatalogs);
    expect(failed).toMatchObject({
      status: "unsupported",
      fetchedAt: new Date(t0.getTime() + 60_000),
    });
    expect(failed?.lastError).toContain("500");

    vi.setSystemTime(t0.getTime() + 120_000);
    deployApp();
    await syncAppTools(syncable());
    vi.setSystemTime(t0.getTime() + 180_000);
    hoisted.env[BINDING] = {
      fetch: async () => new Response("down", { status: 500 }),
    };
    await expect(syncAppTools(syncable())).resolves.toMatchObject({
      status: "error",
    });
    const [catalog] = await db.select().from(appToolCatalogs);
    // The good snapshot keeps serving, and keeps the time it was taken.
    expect(catalog).toMatchObject({
      status: "ok",
      toolCount: 3,
      fetchedAt: new Date(t0.getTime() + 120_000),
    });
    expect(catalog?.lastError).toContain("500");
    expect(await db.select().from(appTools)).toHaveLength(3);
  });

  it("reports a missing binding so the deploy can retry", async () => {
    delete hoisted.env[BINDING];
    await expect(syncAppTools(syncable())).rejects.toMatchObject({
      name: "BindingNotReadyError",
    });
  });

  it("drops the snapshot when the app is deleted", async () => {
    await syncAppTools(syncable());
    await AppService.delete(
      { orgId: organizationId, userId: ownerId, role: "owner" },
      appRowId,
    );
    expect(await db.select().from(appToolCatalogs)).toEqual([]);
    expect(await db.select().from(appTools)).toEqual([]);
  });
});

describe("app-host /mcp with a personal access token", () => {
  it("syncs on first use, then lists from the snapshot without calling the app", async () => {
    const token = await personalToken();

    const first = await mcp(token, "tools/list");
    expect(first.status).toBe(200);
    expect(appRequests).toHaveLength(1); // the first-use sync
    const { result } = (await first.json()) as {
      result: { tools: { name: string }[]; ttlMs: number };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "create_todo",
      "list_todos",
    ]);
    expect(result.ttlMs).toBe(60_000);

    await mcp(token, "tools/list");
    expect(appRequests).toHaveLength(1);
  });

  it("calls the app with a chan:mcp identity bound to the call, on both eras", async () => {
    const token = await personalToken();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    const modern = await mcp(token, "tools/call", {
      name: "create_todo",
      arguments: { title: "buy milk" },
    });
    const body = (await modern.json()) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual({
      todo: { id: "t1", title: "buy milk", completed: false },
    });

    const [patRow] = (await UserPatService.listForUser(ownerId, organizationId))
      .tokens;
    expect(seen.at(-1)).toMatchObject({
      id: ownerId,
      orgId: organizationId,
      orgRole: "owner",
      channel: "mcp",
      actor: { sub: `pat:${patRow!.id}` },
      scopes: ["mcp:read", "mcp:write"],
      toolCall: { name: "create_todo", id: expect.any(String) },
    });

    const init = await mcp(
      token,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cursor", version: "1" },
      },
      "legacy",
    );
    expect(((await init.json()) as { result: object }).result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "every-app-todo", title: "Todos" },
    });
    const legacyCall = await mcp(
      token,
      "tools/call",
      { name: "create_todo", arguments: { title: "taken" } },
      "legacy",
    );
    expect(((await legacyCall.json()) as { result: object }).result).toEqual({
      content: [{ type: "text", text: "That todo already exists" }],
      isError: true,
    });

    const audit = consoleLog.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('"evt":"mcp.tool_call"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      surface: "app",
      app: "todo",
      tool: "create_todo",
      risk: "write",
      decision: "allowed",
      outcome: "ok",
      cred_kind: "pat",
      cred_id: patRow!.id,
      org: organizationId,
      user_id: ownerId,
      request_id: "ray-123",
      proto: "2026-07-28",
      args_digest: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(audit[1]).toMatchObject({
      outcome: "tool_error",
      proto: "2025-06-18",
    });
    expect(JSON.stringify(audit)).not.toContain("buy milk");

    // And one durable row per call, written after the response.
    await Promise.all(hoisted.waitUntil.mock.calls.map(([task]) => task));
    const rows = await db
      .select()
      .from(mcpToolCalls)
      .orderBy(mcpToolCalls.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      surface: "app",
      appRowId,
      appSlug: "todo",
      toolName: "create_todo",
      risk: "write",
      decision: "allowed",
      outcome: "ok",
      credentialKind: "pat",
      credentialId: patRow!.id,
      organizationId,
      userId: ownerId,
      requestId: "ray-123",
      protocolVersion: "2026-07-28",
      argsDigest: audit[0]!["args_digest"],
      id: audit[0]!["call_id"],
    });
    expect(rows[1]).toMatchObject({ outcome: "tool_error" });
    expect(JSON.stringify(rows)).not.toContain("buy milk");
    expect(JSON.stringify(rows)).not.toContain("taken");
    consoleLog.mockRestore();
  });

  it("hides destructive tools and blocks calling them", async () => {
    const token = await personalToken();
    const response = await mcp(token, "tools/call", {
      name: "delete_todo",
      arguments: { id: "t1" },
    });
    expect(((await response.json()) as { error: object }).error).toEqual({
      code: -32602,
      message: "Unknown tool: delete_todo",
    });
    // Only the first-use sync reached the app.
    expect(appRequests.map((r) => new URL(r.url).pathname)).toEqual([
      "/__everyapp/tools/list",
    ]);
  });

  it("gives read-only tokens the read tools and refuses tokens without MCP scopes", async () => {
    const readOnly = await mcp(await personalToken(["mcp:read"]), "tools/list");
    const { result } = (await readOnly.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(result.tools.map((tool) => tool.name)).toEqual(["list_todos"]);

    const apiOnly = await mcp(
      await personalToken(["todos:read"]),
      "tools/list",
    );
    expect(apiOnly.status).toBe(403);
    expect(await apiOnly.json()).toEqual({
      error: "forbidden",
      reason: "token_scope",
    });
  });

  it("challenges a bad token without reaching the ToolBus", async () => {
    const response = await mcp("epat_not-a-real-token", "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="every-app", error="invalid_token", error_description="Use a personal access token here, or connect https://gateway.example.com/mcp"',
    );
    expect(appRequests).toHaveLength(0);
  });

  it("challenges a browser's cross-origin preflight before the ToolBus", async () => {
    // A preflight carries no credentials, so the perimeter answers it; app
    // hosts serve /mcp to browsers on the app's own origin only.
    await syncAppTools(syncable());
    appRequests.length = 0;
    const preflight = await handleGatewayRequest(
      new Request(`https://${HOST}/mcp`, {
        method: "OPTIONS",
        headers: {
          host: HOST,
          origin: "http://localhost:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization, content-type, mcp-protocol-version",
        },
      }),
      gatewayDeps(),
    );
    expect(preflight.status).toBe(401);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    expect(appRequests).toHaveLength(0);
  });

  it("re-syncs once when a call shows the app was redeployed", async () => {
    const token = await personalToken();
    await syncAppTools(syncable());
    // New code behind the same version id: only the call can tell.
    deployApp({ extraTool: true });
    appRequests.length = 0;

    for (let i = 0; i < 3; i += 1) {
      await mcp(token, "tools/call", { name: "list_todos", arguments: {} });
    }
    // Three audit rows and one re-sync, all after the responses.
    await Promise.all(hoisted.waitUntil.mock.calls.map(([task]) => task));
    expect(listCalls()).toBe(1);

    const tools = await db
      .select({ name: appTools.name })
      .from(appTools)
      .where(eq(appTools.appRowId, appRowId));
    expect(tools.map((tool) => tool.name)).toContain("archive_todos");
  });

  it("leaves /mcp to apps that don't serve agent tools", async () => {
    deployApp({ contract: false });
    const response = await mcp(await personalToken(), "tools/list");
    // Proxied to the app as before, which answers /mcp itself.
    expect(await response.text()).toBe("todo app page");
    expect(appRequests.map((r) => new URL(r.url).pathname)).toEqual([
      "/__everyapp/tools/list",
      "/mcp",
    ]);
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog?.status).toBe("unsupported");
  });
});

describe("syncing on first use", () => {
  it("proxies to the app while the catalog tables don't exist yet", async () => {
    // The gateway's deploy ships its code before it runs the migrations.
    await db.run(sql`DROP TABLE app_tools`);
    await db.run(sql`DROP TABLE app_tool_catalogs`);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const response = await mcp(await personalToken(), "tools/list");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("todo app page");
    expect(appRequests.map((r) => new URL(r.url).pathname)).toEqual(["/mcp"]);
    expect(String(consoleWarn.mock.calls[0]?.[0])).toContain(
      '"evt":"mcp.catalog.unavailable"',
    );
  });

  it("retries a catalog that keeps failing every five minutes, not every 30 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-12T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    deployApp({ catalog: "broken" });
    const token = await personalToken();
    const fetchedAt = async () =>
      (await db.select().from(appToolCatalogs))[0]?.fetchedAt.getTime();

    const at = async (offsetMs: number) => {
      vi.setSystemTime(t0 + offsetMs);
      const response = await mcp(token, "tools/list");
      // Nothing to serve: the app answers /mcp itself, as before.
      expect(await response.text()).toBe("todo app page");
    };

    await at(0);
    expect(listCalls()).toBe(1);
    expect(await fetchedAt()).toBe(t0);
    await at(60_000);
    await at(4 * 60_000);
    expect(listCalls()).toBe(1);

    await at(5 * 60_000 + 1);
    expect(listCalls()).toBe(2);
    expect(await fetchedAt()).toBe(t0 + 5 * 60_000 + 1);
    // Past the 30-second per-isolate window, but not five minutes since the
    // last attempt.
    await at(5 * 60_000 + 31_000);
    await at(9 * 60_000);
    expect(listCalls()).toBe(2);

    await at(10 * 60_000 + 2);
    expect(listCalls()).toBe(3);
  });

  it("syncs once for concurrent first requests and serves every one of them", async () => {
    deployApp({ catalog: "slow" });
    const token = await personalToken();
    const responses = await Promise.all(
      [1, 2, 3].map(() => mcp(token, "tools/list")),
    );
    for (const response of responses) {
      const { result } = (await response.json()) as {
        result: { tools: { name: string }[] };
      };
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "create_todo",
        "list_todos",
      ]);
    }
    expect(listCalls()).toBe(1);
  });

  it("serves a request that read the catalog just before another one synced it", async () => {
    const token = await personalToken();
    await mcp(token, "tools/list"); // synced, and claimed for this isolate
    // This request read the catalog as it was before that sync landed.
    vi.spyOn(AppToolRepository, "findByOrgApp").mockResolvedValueOnce({
      appRowId,
      status: "error",
      catalogHash: null,
      instructions: null,
      fetchedAt: new Date(0),
      versionId: null,
      appVersionId: null,
      tools: [],
    });
    const late = await mcp(token, "tools/list");
    expect(await late.json()).toMatchObject({
      result: { tools: [{ name: "create_todo" }, { name: "list_todos" }] },
    });
    expect(listCalls()).toBe(1);
  });

  it("never makes the gateway call the app for a GET", async () => {
    const token = await personalToken();
    const get = await mcpRaw(
      { authorization: `Bearer ${token}` },
      undefined,
      "GET",
    );
    // No catalog yet, so the app answers, and nothing was synced.
    expect(await get.text()).toBe("todo app page");
    expect(listCalls()).toBe(0);

    await syncAppTools(syncable());
    const served = await mcpRaw(
      { authorization: `Bearer ${token}` },
      undefined,
      "GET",
    );
    expect(served.status).toBe(405);
  });
});

describe("syncing a new version", () => {
  /** The app's next deploy: new code, and the version it records. */
  async function redeploy(options: Parameters<typeof deployApp>[0] = {}) {
    deployApp({ extraTool: true, ...options });
    await db
      .update(apps)
      .set({ versionId: "todo-version-2" })
      .where(eq(apps.id, appRowId));
  }

  const toolNames = async (response: Response) =>
    (
      (await response.json()) as { result: { tools: { name: string }[] } }
    ).result.tools.map((tool) => tool.name);

  it("syncs inline on the first POST after a redeploy, then serves the snapshot", async () => {
    const token = await personalToken();
    await mcp(token, "tools/list");
    expect(listCalls()).toBe(1);

    await redeploy();
    // A GET never makes the gateway call the app; it gets the old snapshot.
    await mcpRaw({ authorization: `Bearer ${token}` }, undefined, "GET");
    expect(listCalls()).toBe(1);

    expect(await toolNames(await mcp(token, "tools/list"))).toEqual([
      "archive_todos",
      "create_todo",
      "list_todos",
    ]);
    expect(listCalls()).toBe(2);
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog?.versionId).toBe("todo-version-2");

    await mcp(token, "tools/list");
    expect(listCalls()).toBe(2);
  });

  it("serves the older snapshot while this isolate can't reach the new version", async () => {
    const token = await personalToken();
    await mcp(token, "tools/list");
    await redeploy();
    delete hoisted.env[BINDING];

    expect(await toolNames(await mcp(token, "tools/list"))).toEqual([
      "create_todo",
      "list_todos",
    ]);
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog?.versionId).toBe("todo-version");
  });

  it("keeps serving the older snapshot when the new version's catalog fails, and tries it again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = await personalToken();
    await mcp(token, "tools/list");
    await redeploy({ catalog: "broken" });

    expect(await toolNames(await mcp(token, "tools/list"))).toEqual([
      "create_todo",
      "list_todos",
    ]);
    expect(listCalls()).toBe(2);
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog).toMatchObject({
      status: "ok",
      versionId: "todo-version",
      lastError: expect.stringContaining("500"),
    });

    // The next isolate (or this one, after its window) tries again.
    clearCatalogSyncClaimsForTests();
    deployApp({ extraTool: true });
    expect(await toolNames(await mcp(token, "tools/list"))).toContain(
      "archive_todos",
    );
  });
});

describe("app-host /mcp with a browser session", () => {
  const sameOrigin = {
    cookie: SESSION_COOKIE,
    origin: `https://${HOST}`,
    "sec-fetch-site": "same-origin",
  };
  const createTodo = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_todo", arguments: { title: "from the page" } },
  };

  it("runs a tool for the app's own page and audits it as the session", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await mcpRaw(sameOrigin, createTodo);
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as {
      result: { content: { text: string }[] };
    };
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      todo: { id: "t1", title: "from the page", completed: false },
    });
    expect(seen.at(-1)).toMatchObject({
      id: ownerId,
      channel: "mcp",
      actor: { sub: ownerId },
      scopes: ["mcp:read", "mcp:write"],
      toolCall: { name: "create_todo" },
    });
    expect(auditLines(consoleLog)).toEqual([
      expect.objectContaining({
        tool: "create_todo",
        outcome: "ok",
        cred_kind: "session",
        cred_id: "session",
        user_id: ownerId,
      }),
    ]);
  });

  it("refuses a sibling app's page on the same site", async () => {
    const response = await mcpRaw(
      {
        cookie: SESSION_COOKIE,
        origin: "https://notes-acme.gateway.example.com",
        "sec-fetch-site": "same-site",
      },
      createTodo,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "csrf_denied" });
    expect(appRequests).toHaveLength(0);
    expect(seen).toHaveLength(0);
  });

  it("doesn't sync for a GET that carries the cookie", async () => {
    const response = await mcpRaw(
      { cookie: SESSION_COOKIE, "sec-fetch-site": "same-site" },
      undefined,
      "GET",
    );
    expect(await response.text()).toBe("todo app page");
    expect(listCalls()).toBe(0);
    expect(await db.select().from(appToolCatalogs)).toEqual([]);
  });
});

describe("credentials on app-host /mcp", () => {
  it("refuses a token bound to another app", async () => {
    const notesRowId = await deployLive("notes", {
      id: "notes",
      name: "Notes",
    });
    const token = await personalToken(undefined, { appRowId: notesRowId });
    const response = await mcp(token, "tools/list");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "no_app_access" });
    expect(appRequests).toHaveLength(0);
  });

  it("challenges revoked and expired tokens and deactivated users", async () => {
    const revoked = await personalToken();
    const [revokedRow] = (
      await UserPatService.listForUser(ownerId, organizationId)
    ).tokens;
    await UserPatService.revoke(revokedRow!.id, ownerId);

    const expired = await personalToken();
    await db
      .update(userAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(sql`${userAccessTokens.id} != ${revokedRow!.id}`);

    for (const token of [revoked, expired]) {
      const response = await mcp(token, "tools/list");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="every-app", error="invalid_token", error_description="Use a personal access token here, or connect https://gateway.example.com/mcp"',
      );
    }

    const live = await personalToken();
    await db.update(users).set({ banned: true }).where(eq(users.id, ownerId));
    expect((await mcp(live, "tools/list")).status).toBe(401);
    expect(appRequests).toHaveLength(0);
  });

  it("proxies /mcp to an app whose manifest keeps MCP in the app", async () => {
    await deployLive("todo", { id: "todo", name: "Todos", mcp: "app" });
    await syncAppTools(syncable()); // even with tools in the catalog
    appRequests.length = 0;

    const response = await mcp(await personalToken(), "tools/list");
    expect(await response.text()).toBe("todo app page");
    expect(appRequests.map((r) => new URL(r.url).pathname)).toEqual(["/mcp"]);
  });
});
