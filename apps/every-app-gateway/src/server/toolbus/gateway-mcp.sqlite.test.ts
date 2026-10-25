/**
 * The gateway's own /mcp against a migrated SQLite database, for what the
 * settings model changes there: an app that needs setup serves no tools,
 * the instructions and `everyapp_list_apps` say why with the command that
 * opens it, and it is back once the setting is set. Then the compact
 * surface's gateway side: the listing choice a request carries
 * (`X-EveryApp-Tools`, `?tools=`) reaches the view and its re-reads, and
 * an app with hundreds of tools is snapshotted whole. Drives
 * serveGatewayMcp with a resolved caller; the OAuth flow around it is
 * covered by mcp-auth/gateway-mcp.e2e.sqlite.test.ts.
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
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
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
// The real ToolBus, behind a spy one test swaps for a view capture.
vi.mock("./runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime")>();
  return { ...actual, toolBusHttp: vi.fn(actual.toolBusHttp) };
});

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  planProviderAppOn,
  storedSecretNames,
} from "@every-app/perimeter/registry";
import {
  defineTools,
  everyApp,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import type { McpPrincipal, ToolBusView } from "@every-app/toolbus";
import {
  apps,
  appToolCatalogs,
  mcpConnectionApps,
  mcpConnections,
  userAppAccess,
} from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { withoutWorkspaceTools } from "@/test/mcp-tools";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { clearCatalogSyncClaimsForTests, syncAppTools } from "./catalog-sync";
import { listingChoice, serveGatewayMcp } from "./gateway-mcp";
import { resetToolBusForTests, toolBusHttp } from "./runtime";

const GATEWAY = "https://gateway.example.com";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let organizationId: string;
let ownerId: string;
/** The todo app's row id, for a token or connection bound to it. */
let todoRowId: string;

function objectInput<T>(): PlainToolSchema<T> {
  return {
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: (value) => ({ value: value as T }),
  };
}

/** An app with one read tool, `ping`. */
function pingApp(id: string) {
  return everyApp(
    async () => new Response(`${id} page`),
    { id },
    {
      publicKeys: [keys.publicKeyPem],
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

/** An app with `count` read tools, `tool_000` on: far past any per-app cap. */
function manyToolsApp(count: number) {
  return (id: string) =>
    everyApp(
      async () => new Response(`${id} page`),
      { id },
      {
        publicKeys: [keys.publicKeyPem],
        issuer: GATEWAY,
        tools: defineTools(
          Object.fromEntries(
            Array.from({ length: count }, (_, index) => [
              `tool_${String(index).padStart(3, "0")}`,
              {
                description: `Tool number ${index}.`,
                risk: "read" as const,
                input: objectInput(),
                handler: () => index,
              },
            ]),
          ),
        ),
      },
    );
}

/**
 * Deploy an app live with its manifest, bind its Worker and snapshot its
 * tools: Acme's own, unless `shared` names the platform organization and
 * its owner, which makes it a first-party app every organization reaches.
 */
async function deploy(
  appSlug: string,
  manifest: Record<string, unknown>,
  shared?: { organizationId: string; ownerId: string },
  makeWorker: (id: string) => ReturnType<typeof pingApp> = pingApp,
) {
  const owner = shared ?? { organizationId, ownerId };
  const { app } = await deployLiveApp(db, {
    organizationId: owner.organizationId,
    appSlug,
    name: String(manifest["name"] ?? appSlug),
    description: `The ${appSlug} app`,
    manifest,
    deployerUserId: owner.ownerId,
    appBaseDomain: "gateway.example.com",
    isInstallOrganization: shared !== undefined,
    scope: shared ? "shared" : "org",
  });
  const worker = makeWorker(appSlug);
  hoisted.env[`APP__${app.workerName}`] = {
    fetch: (request: Request) =>
      worker.fetch(
        request,
        // Deployed as everyAppWorker() does: its name is the audience.
        { EVERYAPP_AUDIENCE: app.workerName },
        { waitUntil: () => undefined } as unknown as ExecutionContext,
      ),
  };
  await syncAppTools({
    rowId: app.id,
    organizationId: owner.organizationId,
    appSlug,
    hostname: app.hostname!,
    workerName: app.workerName!,
    tier: "service_binding",
    versionId: app.versionId,
  });
  return app;
}

/**
 * Acme's owner, resolved as a personal token's caller is, unless told
 * otherwise; `apps` narrows the reach to a token's app or a connection's
 * chosen apps, as validate.ts does.
 */
function caller(
  principal: Partial<McpPrincipal> = {},
  apps: { connectionId?: string; appRowId?: string } = {},
): McpCaller {
  return {
    kind: "caller",
    principal: {
      userId: ownerId,
      email: "owner@example.com",
      organizationId,
      organizationName: "acme",
      orgRole: "owner",
      credential: { kind: "pat", id: "pat_1" },
      access: "write",
      ...principal,
    },
    apps,
  };
}

/** How a request chooses its listing: a header, a query string, or neither. */
type ListingRequest = { headers?: Record<string, string>; query?: string };

/** A 2026-07-28 request to the gateway's /mcp. */
function mcp(
  method: string,
  params: Record<string, unknown> = {},
  as: McpCaller = caller(),
  listing: ListingRequest = {},
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return serveGatewayMcp(
    new Request(`${GATEWAY}/mcp${listing.query ?? ""}`, {
      method: "POST",
      headers: {
        host: "gateway.example.com",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}),
        ...listing.headers,
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

async function toolNames(
  as?: McpCaller,
  listing?: ListingRequest,
): Promise<string[]> {
  const response = await mcp("tools/list", {}, as, listing);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  return withoutWorkspaceTools(body.result.tools.map((tool) => tool.name));
}

async function instructions(as?: McpCaller): Promise<string> {
  const response = await mcp("server/discover", {}, as);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { instructions: string };
  };
  return body.result.instructions;
}

async function listApps(as?: McpCaller): Promise<Record<string, unknown>[]> {
  const response = await mcp(
    "tools/call",
    { name: "everyapp_list_apps", arguments: {} },
    as,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { structuredContent: { apps: Record<string, unknown>[] } };
  };
  return body.result.structuredContent.apps;
}

beforeAll(async () => {
  await import("@every-app/toolbus");
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
  hoisted.env["JWT_PRIVATE_KEY"] = keys.privateKeyPem;
});

afterEach(() => {
  delete hoisted.env["OPENROUTER_API_KEY"];
  delete hoisted.env["WORKERS_AI_API_TOKEN"];
  delete hoisted.env["DATAFORSEO_API_KEY"];
  hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "self_hosted";
  vi.restoreAllMocks();
});

beforeEach(async () => {
  db = await createTestDb();
  hoisted.testDb.current = db;
  organizationId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, { organizationId, role: "owner" });
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  todoRowId = (await deploy("todo", { id: "todo", name: "Todos" })).id;
  await deploy("openseo", {
    id: "openseo",
    name: "OpenSEO",
    providers: [{ id: "openrouter", why: "Audits are written by a model." }],
  });
});

describe("the gateway /mcp and an app that needs setup", () => {
  it("serves no tool of it, says why in the instructions, and lists it as unavailable with the command", async () => {
    expect(await toolNames()).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "todo_ping",
    ]);

    const text = await instructions();
    expect(text).toContain("Apps: todo (Todos).");
    expect(text).toContain(
      "openseo (OpenSEO) is not available: needs setup: an admin runs pnpm everyapp configure openseo.",
    );

    expect(await listApps()).toEqual([
      expect.objectContaining({ id: "todo", name: "Todos", tools: 1 }),
      {
        id: "openseo",
        name: "OpenSEO",
        available: false,
        reason: "needs setup: an admin runs pnpm everyapp configure openseo",
      },
    ]);

    const refused = await mcp("tools/call", {
      name: "openseo_ping",
      arguments: {},
    });
    const body = (await refused.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("Unknown tool: openseo_ping");
  });

  it("serves it like any other once the setting is set", async () => {
    hoisted.env["OPENROUTER_API_KEY"] = "sk-or";

    expect(await toolNames()).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "openseo_ping",
      "todo_ping",
    ]);
    const text = await instructions();
    expect(text).toContain("Apps: openseo (OpenSEO), todo (Todos).");
    expect(text).not.toContain("is not available");
    expect((await listApps()).map((app) => app["id"])).toEqual([
      "openseo",
      "todo",
    ]);
    expect(await listApps()).not.toContainEqual(
      expect.objectContaining({ available: false }),
    );
  });

  it("names the --app command when a recorded secret of the app's own is missing", async () => {
    const { id } = await deploy("analytics", {
      id: "analytics",
      name: "Analytics",
      secrets: [{ name: "MAIN_SECRET", why: "Signs the tracking script." }],
    });
    // Names never recorded are unknown, and unknown never blocks.
    expect(await toolNames()).toContain("analytics_ping");

    // The CLI recorded the Worker's names, and MAIN_SECRET isn't among them.
    await db
      .update(apps)
      .set({ secretNames: storedSecretNames([]) })
      .where(eq(apps.id, id));
    expect(await toolNames()).not.toContain("analytics_ping");
    expect(await instructions()).toContain(
      "analytics (Analytics) is not available: needs setup: an admin runs pnpm everyapp configure analytics.",
    );
    expect(await listApps()).toContainEqual({
      id: "analytics",
      name: "Analytics",
      available: false,
      reason: "needs setup: an admin runs pnpm everyapp configure analytics",
    });

    // `secret set` recorded it: the next request serves the app again.
    await db
      .update(apps)
      .set({ secretNames: storedSecretNames(["MAIN_SECRET"]) })
      .where(eq(apps.id, id));
    expect(await toolNames()).toContain("analytics_ping");
  });

  it("names the one configure command for an unmet any-of group, and serves the app once any member is set", async () => {
    await deploy("inbox", {
      id: "inbox",
      name: "Inbox",
      providers: [
        { id: "openrouter", anyOf: "AI model" },
        { id: "workers-ai", anyOf: "AI model" },
      ],
    });
    expect(await toolNames()).not.toContain("inbox_ping");
    expect(await listApps()).toContainEqual({
      id: "inbox",
      name: "Inbox",
      available: false,
      reason: "needs setup: an admin runs pnpm everyapp configure inbox",
    });

    // The other member of the group is enough. A Gateway setting arrives
    // with a new deploy and fresh isolates; here the cached report is
    // dropped by hand instead.
    hoisted.env["WORKERS_AI_API_TOKEN"] = "cf-token";
    resetAppSetupCacheForTests();
    expect(await toolNames()).toContain("inbox_ping");
    expect(await listApps()).not.toContainEqual(
      expect.objectContaining({ id: "inbox", available: false }),
    );
  });

  it("names no command for a shared app seen from another organization", async () => {
    // A hosted gateway: the platform organization's shared app reaches
    // every organization, but only the platform's own members can set it up.
    hoisted.env["GATEWAY_DEPLOYMENT_MODE"] = "hosted";
    const platformId = await seedOrganization(db, "platform");
    const platformOwnerId = await seedMember(db, {
      organizationId: platformId,
      role: "owner",
    });
    await deploy(
      "crm",
      {
        id: "crm",
        name: "CRM",
        providers: [{ id: "openrouter", why: "Drafts replies." }],
      },
      { organizationId: platformId, ownerId: platformOwnerId },
    );

    // Acme's owner: the app is listed, without a command to run.
    expect(await toolNames()).not.toContain("crm_ping");
    expect(await instructions()).toContain(
      "crm (CRM) is not available: needs setup.",
    );
    expect(await listApps()).toContainEqual({
      id: "crm",
      name: "CRM",
      available: false,
      reason: "needs setup",
    });

    // The platform's owner sees the same app with the command.
    const platformOwner = caller({
      userId: platformOwnerId,
      email: "platform@example.com",
      organizationId: platformId,
      organizationName: "platform",
    });
    expect(await toolNames(platformOwner)).not.toContain("crm_ping");
    expect(await listApps(platformOwner)).toContainEqual({
      id: "crm",
      name: "CRM",
      available: false,
      reason: "needs setup: an admin runs pnpm everyapp configure crm",
    });

    // Set on the Gateway (a new deploy, so a fresh cache): back for everyone.
    hoisted.env["OPENROUTER_API_KEY"] = "sk-or";
    resetAppSetupCacheForTests();
    expect(await toolNames()).toContain("crm_ping");
    expect(await toolNames(platformOwner)).toContain("crm_ping");
  });
});

describe("the gateway /mcp and a provider app an admin could turn on", () => {
  const LINE =
    "dataforseo (DataForSEO) is off and its key is set: an admin runs pnpm everyapp mcp on dataforseo.";
  const ENTRY = {
    id: "dataforseo",
    name: "DataForSEO",
    available: false,
    offered: true,
    reason:
      "off and its key is set: an admin runs pnpm everyapp mcp on dataforseo",
  };
  const OFFERED = expect.objectContaining({ offered: true });

  /** The row `everyapp mcp on dataforseo` writes, with its grants. */
  async function turnOn(): Promise<void> {
    const plan = planProviderAppOn({
      organizationId,
      id: "dataforseo",
      existingApp: null,
      members: [{ id: ownerId, role: "owner" }],
      actorUserId: ownerId,
      actor: "owner@example.com",
      now: Date.now(),
    });
    const row = {
      ...plan.app,
      deployedAt:
        plan.app.deployedAt === null ? null : new Date(plan.app.deployedAt),
    };
    await db.batch([
      db.insert(apps).values(row),
      ...plan.grants.map((grant) =>
        db.insert(userAppAccess).values(grant).onConflictDoNothing(),
      ),
    ]);
  }

  it("names it to the install organization's owners and admins while its key is set, and to nobody else", async () => {
    // No key: nothing to offer, whoever asks.
    expect(await instructions()).not.toContain("is off and its key is set");

    hoisted.env["DATAFORSEO_API_KEY"] = "api-login@example.com:s3cret";
    const text = await instructions();
    expect(text).toContain("Apps: todo (Todos).");
    // After the not-available line, in the head.
    expect(text.split("\n").slice(0, 4)).toEqual([
      expect.stringMatching(/^Tools for acme on Every App\./),
      "Apps: todo (Todos).",
      "openseo (OpenSEO) is not available: needs setup: an admin runs pnpm everyapp configure openseo.",
      LINE,
    ]);
    expect(await listApps()).toContainEqual(ENTRY);
    expect(await toolNames()).not.toContain("dataforseo_keyword_overview");

    // An admin too.
    const adminId = await seedMember(db, { organizationId, role: "admin" });
    const admin = caller({
      userId: adminId,
      email: "admin@example.com",
      orgRole: "admin",
    });
    expect(await instructions(admin)).toContain(LINE);

    // A member: operator state is not theirs.
    const memberId = await seedMember(db, { organizationId, role: "member" });
    const member = caller({
      userId: memberId,
      email: "member@example.com",
      orgRole: "member",
    });
    expect(await instructions(member)).not.toContain(
      "is off and its key is set",
    );
    expect(await listApps(member)).not.toContainEqual(OFFERED);

    // Another organization's owner: `mcp on` writes the install
    // organization's row, so the line is not for them.
    const otherOrg = await seedOrganization(db, "other");
    const otherOwner = await seedMember(db, {
      organizationId: otherOrg,
      role: "owner",
    });
    const other = caller({
      userId: otherOwner,
      email: "other@example.com",
      organizationId: otherOrg,
      organizationName: "other",
      orgRole: "owner",
    });
    expect(await instructions(other)).not.toContain(
      "is off and its key is set",
    );
  });

  it("stops offering it once it is on, when it is served like any app", async () => {
    hoisted.env["DATAFORSEO_API_KEY"] = "api-login@example.com:s3cret";
    expect(await instructions()).toContain(LINE);

    await turnOn();
    // A POST syncs the provider's catalog before the view is built.
    const names = await toolNames();
    expect(names).toContain("dataforseo_keyword_overview");
    const text = await instructions();
    expect(text).toContain("Apps: dataforseo (DataForSEO), todo (Todos).");
    expect(text).not.toContain("is off and its key is set");
    expect(await listApps()).not.toContainEqual(OFFERED);
  });

  it("decides from the install organization's rows, not the caller's view: nobody is told to turn on what is on", async () => {
    hoisted.env["DATAFORSEO_API_KEY"] = "api-login@example.com:s3cret";
    await turnOn();

    // An admin added after `mcp on`: no grant, so no catalog in their view.
    const adminId = await seedMember(db, { organizationId, role: "admin" });
    const admin = caller({
      userId: adminId,
      email: "admin@example.com",
      orgRole: "admin",
    });
    expect(await toolNames(admin)).not.toContain("dataforseo_keyword_overview");
    expect(await instructions(admin)).not.toContain(
      "is off and its key is set",
    );
    expect(await listApps(admin)).not.toContainEqual(OFFERED);

    // The owner's token bound to one app.
    const bound = caller({}, { appRowId: todoRowId });
    expect(await instructions(bound)).toContain("Apps: todo (Todos).");
    expect(await instructions(bound)).not.toContain(
      "is off and its key is set",
    );
    expect(await listApps(bound)).not.toContainEqual(OFFERED);

    // The owner's connection that chose todo alone.
    const connectionId = `mcpc_${"c".repeat(32)}`;
    await db.insert(mcpConnections).values({
      id: connectionId,
      userId: ownerId,
      organizationId,
      clientId: "client-1",
      clientName: "Claude",
      redirectUri: "https://claude.ai/callback",
      redirectHost: "claude.ai",
      appScope: "selected",
      access: "write",
      createdAt: new Date(),
    });
    await db
      .insert(mcpConnectionApps)
      .values({ connectionId, appRowId: todoRowId });
    const selected = caller({}, { connectionId });
    expect(await instructions(selected)).toContain("Apps: todo (Todos).");
    expect(await instructions(selected)).not.toContain(
      "is off and its key is set",
    );
    expect(await listApps(selected)).not.toContainEqual(OFFERED);
  });

  it("doesn't offer it while a deployed app lists the provider's capability: the key is that app's", async () => {
    hoisted.env["DATAFORSEO_API_KEY"] = "api-login@example.com:s3cret";
    expect(await instructions()).toContain(LINE);

    await deploy("seo", {
      id: "seo",
      name: "SEO",
      capabilities: { dataforseo: { access: "read", why: "Keyword data." } },
    });
    const text = await instructions();
    expect(text).toContain("Apps: seo (SEO), todo (Todos).");
    expect(text).not.toContain("is off and its key is set");
    expect(await listApps()).not.toContainEqual(OFFERED);
  });
});

describe("the listing choice on the gateway /mcp", () => {
  const BUILTINS_COMPACT = [
    "everyapp_list_apps",
    "everyapp_whoami",
    "everyapp_search_tools",
    "everyapp_call_read",
    "everyapp_call_write",
  ];

  it("reads X-EveryApp-Tools or ?tools=, case-insensitively, the header first", () => {
    const choice = (init: { header?: string; query?: string }) =>
      listingChoice(
        new Request(`${GATEWAY}/mcp${init.query ?? ""}`, {
          method: "POST",
          headers:
            init.header === undefined
              ? {}
              : { "X-EveryApp-Tools": init.header },
        }),
      );
    expect(choice({})).toBeUndefined();
    expect(choice({ header: "compact" })).toBe("compact");
    expect(choice({ header: "Full" })).toBe("full");
    expect(choice({ header: " COMPACT " })).toBe("compact");
    expect(choice({ query: "?tools=compact" })).toBe("compact");
    expect(choice({ query: "?tools=FULL" })).toBe("full");
    expect(choice({ query: "?foo=1&tools=compact" })).toBe("compact");
    // Both given: the header is this request's own word.
    expect(choice({ header: "full", query: "?tools=compact" })).toBe("full");
    // Anything else is no choice at all, and the view decides.
    expect(choice({ header: "terse" })).toBeUndefined();
    expect(choice({ header: "" })).toBeUndefined();
    expect(choice({ query: "?tools=" })).toBeUndefined();
    expect(choice({ query: "?tools=all" })).toBeUndefined();
    expect(choice({ header: "wide", query: "?tools=narrow" })).toBeUndefined();
  });

  it("passes the choice into the view, and a held stream's re-read keeps it", async () => {
    const views: ToolBusView[] = [];
    const capture = async (_request: Request, view: ToolBusView) => {
      views.push(view);
      return new Response(null, { status: 204 });
    };
    const serve = vi.mocked(toolBusHttp);
    serve.mockResolvedValueOnce(capture);
    await mcp("tools/list", {}, caller(), {
      headers: { "X-EveryApp-Tools": "compact" },
    });
    serve.mockResolvedValueOnce(capture);
    await mcp("tools/list", {}, caller(), { query: "?tools=full" });
    serve.mockResolvedValueOnce(capture);
    await mcp("tools/list", {}, caller(), { query: "?tools=sideways" });
    serve.mockResolvedValueOnce(capture);
    await mcp("tools/list", {}, caller());
    // An explicit choice is the view's; without one the view decides, and
    // two apps of one tool each are listed in full.
    expect(views.map((view) => view.listing)).toEqual([
      "compact",
      "full",
      "full",
      "full",
    ]);
    // Every caller kind: an OAuth connection reads the same header.
    serve.mockResolvedValueOnce(capture);
    await mcp(
      "tools/list",
      {},
      caller({ credential: { kind: "oauth", id: "mcpc_1" }, access: "read" }),
      { headers: { "x-everyapp-tools": "compact" } },
    );
    expect(views[4]?.listing).toBe("compact");

    // The re-read a held subscriptions/listen stream polls carries the
    // same choice, read once from the request: the stream was opened
    // compact and stays compact, however the catalogs move.
    const compact = views[0]!;
    expect(compact.refresh).toBeDefined();
    const again = await compact.refresh!();
    expect(again.listing).toBe("compact");
    expect(again.apps.map((app) => app.appId)).toEqual(["todo"]);
    const twice = await again.refresh!();
    expect(twice.listing).toBe("compact");
    const full = await views[1]!.refresh!();
    expect(full.listing).toBe("full");
  });

  it("lists the built-ins only when compact is chosen, and every tool when full is", async () => {
    // The view's listing drives the ToolBus's tools/list: compact lists
    // the built-ins and the two wrappers, no app tool; full lists the
    // read-only built-ins and then the apps' tools, as it always has.
    expect(await toolNames(caller(), { query: "?tools=compact" })).toEqual(
      BUILTINS_COMPACT,
    );
    expect(
      await toolNames(caller(), { headers: { "X-EveryApp-Tools": "full" } }),
    ).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      "todo_ping",
    ]);
    // A read-only caller is never offered the write wrapper.
    expect(
      await toolNames(caller({ access: "read" }), { query: "?tools=compact" }),
    ).toEqual(
      BUILTINS_COMPACT.filter((name) => name !== "everyapp_call_write"),
    );
  });
});

describe("an app with hundreds of tools", () => {
  it("is snapshotted whole, with no per-app cap, and listed whole on request", async () => {
    const app = await deploy(
      "big",
      { id: "big", name: "Big" },
      undefined,
      manyToolsApp(300),
    );

    // One atomic D1 batch wrote all 300 rows (AppToolRepository.replace),
    // and the sync recorded no warning about tools left out.
    const stored = await AppToolRepository.findByOrgApp(organizationId, "big");
    expect(stored?.status).toBe("ok");
    expect(stored?.tools).toHaveLength(300);
    expect(stored?.tools.map((tool) => tool.name).slice(0, 2)).toEqual([
      "tool_000",
      "tool_001",
    ]);
    const [catalog] = await db
      .select({
        toolCount: appToolCatalogs.toolCount,
        warnings: appToolCatalogs.warnings,
      })
      .from(appToolCatalogs)
      .where(eq(appToolCatalogs.appRowId, app.id));
    expect(catalog).toEqual({ toolCount: 300, warnings: null });

    // Asked for in full, every one of them is listed.
    const full = await toolNames(caller(), {
      headers: { "X-EveryApp-Tools": "full" },
    });
    expect(full.filter((name) => name.startsWith("big_"))).toHaveLength(300);
    expect(full).toContain("big_tool_299");
    // Left to the view, 301 app tools pass FULL_LISTING_MAX_TOOLS: the
    // listing is compact, and the tools are found through the built-ins.
    const chosen = await toolNames();
    expect(chosen).not.toContain("big_tool_000");
    expect(chosen).toContain("everyapp_search_tools");
    expect(chosen).toContain("everyapp_call_read");
  });
});
