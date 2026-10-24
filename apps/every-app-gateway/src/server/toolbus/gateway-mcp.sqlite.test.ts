/**
 * The gateway's own /mcp against a migrated SQLite database, for what the
 * settings model changes there: an app that needs setup serves no tools,
 * the instructions and `everyapp_list_apps` say why with the command that
 * opens it, and it is back once the setting is set. Drives serveGatewayMcp
 * with a resolved caller; the OAuth flow around it is covered by
 * mcp-auth/gateway-mcp.e2e.sqlite.test.ts.
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

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { storedSecretNames } from "@every-app/perimeter/registry";
import {
  defineTools,
  everyApp,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import type { McpPrincipal } from "@every-app/toolbus";
import { apps } from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { clearCatalogSyncClaimsForTests, syncAppTools } from "./catalog-sync";
import { serveGatewayMcp } from "./gateway-mcp";
import { resetToolBusForTests } from "./runtime";

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

/**
 * Deploy an app live with its manifest, bind its Worker and snapshot its
 * tools: Acme's own, unless `shared` names the platform organization and
 * its owner, which makes it a first-party app every organization reaches.
 */
async function deploy(
  appSlug: string,
  manifest: Record<string, unknown>,
  shared?: { organizationId: string; ownerId: string },
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
  const worker = pingApp(appSlug);
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

/** Acme's owner, resolved as a personal token's caller is, unless told otherwise. */
function caller(principal: Partial<McpPrincipal> = {}): McpCaller {
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
    apps: {},
  };
}

/** A 2026-07-28 request to the gateway's /mcp. */
function mcp(
  method: string,
  params: Record<string, unknown> = {},
  as: McpCaller = caller(),
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

async function toolNames(as?: McpCaller): Promise<string[]> {
  const response = await mcp("tools/list", {}, as);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  return body.result.tools.map((tool) => tool.name);
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
  await deploy("todo", { id: "todo", name: "Todos" });
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
      "todo_ping",
    ]);

    const text = await instructions();
    expect(text).toContain("Apps: todo (Todos).");
    expect(text).toContain(
      "openseo (OpenSEO) is not available: needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY.",
    );

    expect(await listApps()).toEqual([
      expect.objectContaining({ id: "todo", name: "Todos", tools: 1 }),
      {
        id: "openseo",
        name: "OpenSEO",
        available: false,
        reason:
          "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY",
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
      "analytics (Analytics) is not available: needs setup: an admin runs pnpm everyapp secret set MAIN_SECRET --app analytics.",
    );
    expect(await listApps()).toContainEqual({
      id: "analytics",
      name: "Analytics",
      available: false,
      reason:
        "needs setup: an admin runs pnpm everyapp secret set MAIN_SECRET --app analytics",
    });

    // `secret set` recorded it: the next request serves the app again.
    await db
      .update(apps)
      .set({ secretNames: storedSecretNames(["MAIN_SECRET"]) })
      .where(eq(apps.id, id));
    expect(await toolNames()).toContain("analytics_ping");
  });

  it("says the alternatives of an unmet any-of group, and serves the app once any is set", async () => {
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
      reason:
        "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY (WORKERS_AI_API_TOKEN instead of OPENROUTER_API_KEY is fine too: one AI model is enough)",
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
      reason:
        "needs setup: an admin runs pnpm everyapp secret set OPENROUTER_API_KEY",
    });

    // Set on the Gateway (a new deploy, so a fresh cache): back for everyone.
    hoisted.env["OPENROUTER_API_KEY"] = "sk-or";
    resetAppSetupCacheForTests();
    expect(await toolNames()).toContain("crm_ping");
    expect(await toolNames(platformOwner)).toContain("crm_ping");
  });
});
