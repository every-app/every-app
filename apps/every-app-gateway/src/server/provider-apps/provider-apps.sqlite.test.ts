/**
 * A provider app end to end through the gateway's own /mcp: the real
 * worker entry (server.ts), every migration on SQLite, a personal access
 * token, the row `everyapp provider on` writes, the catalog synced from the
 * in-process DataForSEO app on first use, a tool call through the
 * capability proxy to a stand-in DataForSEO, the key never leaving the
 * gateway, the usage counted against the row and the call audited; and
 * what takes the tools away again (no key, no access, turned off).
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
  controlPlane: vi.fn(async () => new Response("control plane")),
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
vi.mock("@/auth", () => ({
  createAuth: vi.fn(),
  auth: { api: { getSession: async () => null } },
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: { fetch: hoisted.controlPlane },
}));

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  planProviderAppOn,
  providerAppOffUpdate,
} from "@every-app/perimeter/registry";
import { PROVIDER_APP_TIER } from "@every-app/sdk/internal";
import {
  apps,
  appToolCatalogs,
  events,
  mcpToolCalls,
  orgAppSettings,
  usageDaily,
  userAppAccess,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { consentChoices } from "@/server/mcp-auth/consent";
import { clearAppCapCache } from "@/server/app-cap";
import { resetRegistrationLimitsForTests } from "@/server/mcp-auth/registration-limit";
import { AppToolRepository } from "@/server/repositories/AppToolRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { resetAppHostMcpForTests } from "@/server/toolbus/app-host-mcp";
import { clearCatalogSyncClaimsForTests } from "@/server/toolbus/catalog-sync";
import { createKvFake } from "@/test/kv-fake";
import { withoutWorkspaceTools } from "@/test/mcp-tools";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import { setProviderUpstreamFetchForTests } from "./call";
import {
  providerCatalogVersion,
  resetProviderCatalogVersionForTests,
} from "./index";

const GATEWAY = "https://gateway.example.com";
const HOST = "gateway.example.com";
const KEY = "api-login@example.com:s3cret-api-password";
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};

/** Every DataForSEO tool the provider app serves, under its prefix. */
const DATAFORSEO_TOOLS = [
  "dataforseo_backlinks",
  "dataforseo_backlinks_summary",
  "dataforseo_competitors_domain",
  "dataforseo_domain_intersection",
  "dataforseo_domain_rank_overview",
  "dataforseo_keyword_difficulty",
  "dataforseo_keyword_ideas",
  "dataforseo_keyword_overview",
  "dataforseo_keyword_search_volume",
  "dataforseo_keyword_suggestions",
  "dataforseo_ranked_keywords",
  "dataforseo_referring_domains",
  "dataforseo_related_keywords",
  "dataforseo_search_intent",
  "dataforseo_serp_google",
  "dataforseo_serp_google_autocomplete",
  "dataforseo_serp_google_maps",
];

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let orgId: string;
let ownerId: string;
let memberId: string;
let rowId: string;
/** What the stand-in DataForSEO received. */
let upstream: Array<{ url: string; headers: Headers; body: string }>;
let answer: () => Response;

function dataforseoAnswer(cost = 0.012): Response {
  return Response.json({
    version: "0.1.20260101",
    status_code: 20000,
    status_message: "Ok.",
    time: "0.1 sec.",
    cost,
    tasks_count: 1,
    tasks_error: 0,
    tasks: [
      {
        id: "task-1",
        status_code: 20000,
        status_message: "Ok.",
        time: "0.1 sec.",
        cost,
        result_count: 1,
        path: ["v3", "dataforseo_labs", "google", "keyword_overview", "live"],
        data: { api: "dataforseo_labs" },
        result: [
          {
            items: [
              { keyword: "seo tools", keyword_info: { search_volume: 1200 } },
            ],
          },
        ],
      },
    ],
  });
}

async function settle(): Promise<void> {
  while (hoisted.background.length) {
    await Promise.all(hoisted.background.splice(0));
  }
}

function send(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  return server.fetch(new Request(`${GATEWAY}${path}`, { ...init, headers }));
}

function mcp(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return send("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
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
  });
}

async function toolNames(token: string): Promise<string[]> {
  const response = await mcp(token, "tools/list");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return withoutWorkspaceTools(body.result.tools.map((tool) => tool.name));
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{
  result?: {
    content: { text: string }[];
    structuredContent?: unknown;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}> {
  const response = await mcp(token, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: {
      content: { text: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    error?: { code: number; message: string };
  };
  await settle();
  return body;
}

async function pat(userId: string, scopes?: string[]): Promise<string> {
  const { plaintext } = await UserPatService.create({
    userId,
    organizationId: orgId,
    name: "claude code",
    scopes,
  });
  return plaintext;
}

/** The row `everyapp provider on` writes, with its initial access. */
async function turnOn(actorUserId: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(apps)
    .where(eq(apps.appSlug, "dataforseo"));
  const members = await db.query.members.findMany({
    where: (members, { eq }) => eq(members.organizationId, orgId),
  });
  const plan = planProviderAppOn({
    organizationId: orgId,
    id: "dataforseo",
    existingApp: existing
      ? {
          ...existing,
          deployedAt: existing.deployedAt?.getTime() ?? null,
        }
      : null,
    members: members.map((member) => ({
      id: member.userId,
      role: member.role,
    })),
    actorUserId,
    actor: "ben@example.com",
    now: Date.now(),
  });
  const row = {
    ...plan.app,
    deployedAt:
      plan.app.deployedAt === null ? null : new Date(plan.app.deployedAt),
  };
  await db.batch([
    db
      .insert(apps)
      .values(row)
      .onConflictDoUpdate({ target: apps.id, set: row }),
    ...plan.grants.map((grant) =>
      db.insert(userAppAccess).values(grant).onConflictDoNothing(),
    ),
  ]);
  return plan.app.id;
}

async function turnOff(): Promise<void> {
  const [existing] = await db
    .select()
    .from(apps)
    .where(eq(apps.appSlug, "dataforseo"));
  const update = providerAppOffUpdate("dataforseo", {
    ...existing!,
    deployedAt: existing!.deployedAt?.getTime() ?? null,
  });
  await db.update(apps).set(update!).where(eq(apps.id, existing!.id));
  await db
    .delete(userAppAccess)
    .where(eq(userAppAccess.appRowId, existing!.id));
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  keys = { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
});

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "self_hosted",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    JWT_PUBLIC_KEY: keys.publicKeyPem,
    DATAFORSEO_API_KEY: KEY,
    DB: { prepare: () => undefined },
    OAUTH_KV: createKvFake().kv,
  });
  hoisted.background.length = 0;
  resetAppHostMcpForTests();
  resetRegistrationLimitsForTests();
  clearCatalogSyncClaimsForTests();
  clearHostnameCacheForTests();
  resetProviderCatalogVersionForTests();
  clearAppCapCache();
  db = await createTestDb();
  hoisted.testDb.current = db;
  orgId = await seedOrganization(db, "acme");
  ownerId = await seedMember(db, { organizationId: orgId, role: "owner" });
  memberId = await seedMember(db, { organizationId: orgId, role: "member" });
  rowId = await turnOn(ownerId);
  upstream = [];
  answer = () => dataforseoAnswer();
  setProviderUpstreamFetchForTests(async (input, init) => {
    const request = new Request(input, init);
    upstream.push({
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    return answer();
  });
});

afterEach(async () => {
  await settle();
  setProviderUpstreamFetchForTests(undefined);
  vi.restoreAllMocks();
});

describe("a provider app on the gateway's /mcp", () => {
  it("lists its tools for a member with access, synced from the in-process app on first use", async () => {
    const token = await pat(ownerId);
    expect(await toolNames(token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
      ...DATAFORSEO_TOOLS,
    ]);
    const [catalog] = await db
      .select()
      .from(appToolCatalogs)
      .where(eq(appToolCatalogs.appRowId, rowId));
    expect(catalog).toMatchObject({
      status: "ok",
      toolCount: DATAFORSEO_TOOLS.length,
      versionId: await providerCatalogVersion(),
    });
    expect(upstream).toEqual([]);

    // Every tool is read-only, titled, and reaches beyond the gateway.
    const response = await mcp(token, "tools/list");
    const { result } = (await response.json()) as {
      result: {
        tools: Array<{
          name: string;
          title?: string;
          annotations: Record<string, unknown>;
        }>;
      };
    };
    for (const tool of result.tools.filter((tool) =>
      tool.name.startsWith("dataforseo_"),
    )) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
    await settle();
  });

  it("lists nothing of it for a member without access, and everything again once granted", async () => {
    const token = await pat(memberId);
    expect(await toolNames(token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
    ]);
    await db.insert(userAppAccess).values({
      id: "grant-member",
      organizationId: orgId,
      userId: memberId,
      appRowId: rowId,
    });
    expect(await toolNames(token)).toContain("dataforseo_keyword_overview");
  });

  it("calls the provider through the capability proxy with the gateway's key, tagged with the organization, and counts and audits the call", async () => {
    const token = await pat(ownerId, ["mcp:read"]);
    const call = await callTool(token, "dataforseo_keyword_overview", {
      keywords: ["seo tools"],
    });
    expect(call.error).toBeUndefined();
    expect(call.result?.isError).toBeUndefined();
    // A plain JSON value comes back as one JSON text block.
    expect(JSON.parse(call.result!.content[0]!.text)).toEqual({
      cost: 0.012,
      result: [
        {
          items: [
            { keyword: "seo tools", keyword_info: { search_volume: 1200 } },
          ],
        },
      ],
    });

    expect(upstream).toHaveLength(1);
    const [request] = upstream;
    expect(request!.url).toBe(
      "https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_overview/live",
    );
    expect(request!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(KEY).toString("base64")}`,
    );
    expect(request!.headers.get("x-everyapp-identity")).toBeNull();
    expect(JSON.parse(request!.body)).toEqual([
      {
        keywords: ["seo tools"],
        location_code: 2840,
        language_code: "en",
        tag: `everyapp:${orgId}`,
      },
    ]);

    // The key is nowhere in what the client got.
    const text = JSON.stringify(call);
    expect(text).not.toContain("s3cret-api-password");
    expect(text).not.toContain(Buffer.from(KEY).toString("base64"));

    const [audit] = await db.select().from(mcpToolCalls);
    expect(audit).toMatchObject({
      surface: "gateway",
      appRowId: rowId,
      appSlug: "dataforseo",
      toolName: "dataforseo_keyword_overview",
      risk: "read",
      decision: "allowed",
      outcome: "ok",
      userId: ownerId,
      credentialKind: "pat",
    });
    const [usage] = await db.select().from(usageDaily);
    expect(usage).toMatchObject({
      organizationId: orgId,
      appRowId: rowId,
      userId: ownerId,
      kind: "capability",
      target: "dataforseo",
      calls: 1,
      failures: 0,
      costMicros: 12_000,
    });
  });

  it("passes a named location and the caller's limits through, and reads the provider's task error as a tool error", async () => {
    const token = await pat(ownerId);
    await callTool(token, "dataforseo_keyword_suggestions", {
      keyword: "running shoes",
      location_name: "London,England,United Kingdom",
      language_code: "en",
      limit: 5,
    });
    expect(JSON.parse(upstream[0]!.body)).toEqual([
      {
        keyword: "running shoes",
        location_name: "London,England,United Kingdom",
        language_code: "en",
        limit: 5,
        tag: `everyapp:${orgId}`,
      },
    ]);

    answer = () =>
      Response.json({
        status_code: 20000,
        status_message: "Ok.",
        cost: 0,
        tasks: [
          {
            id: "task-2",
            status_code: 40501,
            status_message: "Invalid Field: 'location_name'.",
            cost: 0,
            result: null,
          },
        ],
      });
    const failed = await callTool(token, "dataforseo_keyword_suggestions", {
      keyword: "x",
      location_name: "Nowhere",
    });
    expect(failed.result?.isError).toBe(true);
    expect(failed.result?.content[0]?.text).toBe(
      "DataForSEO: Invalid Field: 'location_name' (40501).",
    );
  });

  it("refuses arguments the schema refuses before any call", async () => {
    const token = await pat(ownerId);
    const call = await callTool(token, "dataforseo_keyword_overview", {
      keywords: [],
    });
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content[0]?.text).toContain("Invalid arguments");
    expect(upstream).toEqual([]);
    expect(await db.select().from(usageDaily)).toEqual([]);
  });

  it("leaves its tools out while the key isn't set, like any app that needs setup, and names the command", async () => {
    delete hoisted.env["DATAFORSEO_API_KEY"];
    const token = await pat(ownerId);
    expect(await toolNames(token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
    ]);
    const listed = await callTool(token, "everyapp_list_apps", {});
    expect(listed.result?.structuredContent).toEqual({
      apps: [
        {
          id: "dataforseo",
          name: "DataForSEO",
          available: false,
          reason: expect.stringContaining("secret set DATAFORSEO_API_KEY"),
        },
      ],
    });
    const call = await callTool(token, "dataforseo_search_intent", {
      keywords: ["buy shoes"],
    });
    expect(call.error).toMatchObject({ code: -32602 });
    expect(upstream).toEqual([]);
    expect(await db.select().from(usageDaily)).toEqual([]);
  });

  it("counts a provider error as a failed call and reads it as a tool error", async () => {
    answer = () =>
      Response.json(
        {
          status_code: 40100,
          status_message: "You are not authorized to access this resource.",
        },
        { status: 401 },
      );
    const token = await pat(ownerId);
    const call = await callTool(token, "dataforseo_backlinks_summary", {
      target: "example.com",
    });
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content[0]?.text).toBe(
      "DataForSEO answered 40100: You are not authorized to access this resource.",
    );
    const [usage] = await db.select().from(usageDaily);
    expect(usage).toMatchObject({ calls: 1, failures: 1, costMicros: 0 });
  });

  it("takes the tools away when the app is turned off, and brings them back when it is on again", async () => {
    const token = await pat(ownerId);
    expect(await toolNames(token)).toContain("dataforseo_serp_google");
    await turnOff();
    expect(await toolNames(token)).toEqual([
      "everyapp_list_apps",
      "everyapp_whoami",
      "everyapp_search_tools",
    ]);
    rowId = await turnOn(ownerId);
    expect(await toolNames(token)).toContain("dataforseo_serp_google");
  });

  it("re-syncs a snapshot taken from another provider catalog version, and leaves a current one alone", async () => {
    await toolNames(await pat(ownerId));
    const scope = { organizationId: orgId, userId: ownerId, sharedApps: false };
    const query = (providerCatalogVersion: string) =>
      AppToolRepository.findVisibleUnsyncedApps(scope, {
        failedBefore: new Date(0),
        limit: 20,
        providerCatalogVersion,
      });
    expect(await query(await providerCatalogVersion())).toEqual([]);
    expect(
      (await query("provider:00000000000000000000000000000000")).map(
        (app) => app.appSlug,
      ),
    ).toEqual(["dataforseo"]);
  });

  it("shows the app on the consent page with its tools ready, and in everyapp_list_apps with the gateway's URL", async () => {
    const token = await pat(ownerId);
    const call = await callTool(token, "everyapp_list_apps", {});
    expect(call.result?.structuredContent).toEqual({
      apps: [
        {
          id: "dataforseo",
          name: "DataForSEO",
          description: expect.stringContaining("SEO data"),
          url: GATEWAY,
          tools: DATAFORSEO_TOOLS.length,
        },
      ],
    });
    const [organization] = await consentChoices(ownerId);
    expect(organization?.apps).toEqual([
      { rowId, slug: "dataforseo", name: "DataForSEO", tools: "ready" },
    ]);
  });

  it("verifies identities with the private key's public half when JWT_PUBLIC_KEY was never written", async () => {
    delete hoisted.env["JWT_PUBLIC_KEY"];
    resetProviderCatalogVersionForTests();
    const token = await pat(ownerId);
    expect(await toolNames(token)).toContain("dataforseo_keyword_overview");
    const call = await callTool(token, "dataforseo_keyword_overview", {
      keywords: ["seo tools"],
    });
    expect(call.result?.isError).toBeUndefined();
    expect(upstream).toHaveLength(1);
  });

  it("is never routed by the perimeter, even with a hostname on its row", async () => {
    // A provider row has no hostname; were one written, the registry
    // would still not return the row (tier provider is left out, as
    // tombstones are), so the host is unknown rather than served.
    await db
      .update(apps)
      .set({ hostname: "dataforseo.gateway.example.com" })
      .where(eq(apps.id, rowId));
    clearHostnameCacheForTests();
    const response = await server.fetch(
      new Request("https://dataforseo.gateway.example.com/", {
        headers: { host: "dataforseo.gateway.example.com" },
      }),
    );
    expect(response.status).toBe(404);
  });

  it("sends search intent as keywords alone, as the endpoint takes them", async () => {
    const token = await pat(ownerId);
    await callTool(token, "dataforseo_search_intent", {
      keywords: ["buy running shoes", "what is seo"],
    });
    expect(upstream[0]!.url).toBe(
      "https://api.dataforseo.com/v3/dataforseo_labs/google/search_intent/live",
    );
    expect(JSON.parse(upstream[0]!.body)).toEqual([
      {
        keywords: ["buy running shoes", "what is seo"],
        tag: `everyapp:${orgId}`,
      },
    ]);
  });

  it("refuses a call once the organization's monthly cap on the app is reached, counting nothing", async () => {
    const token = await pat(ownerId);
    await callTool(token, "dataforseo_keyword_overview", { keywords: ["seo"] });
    expect(upstream).toHaveLength(1);
    await db.insert(orgAppSettings).values({
      organizationId: orgId,
      appRowId: rowId,
      monthlyCallCap: 1,
      updatedAt: new Date(),
      updatedBy: ownerId,
    });
    clearAppCapCache();

    const call = await callTool(token, "dataforseo_keyword_overview", {
      keywords: ["seo tools"],
    });
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content[0]?.text).toBe(
      "DataForSEO has reached its monthly cap of 1 provider calls for this organization. Its AI and provider calls are refused until the month ends (UTC) or an owner or admin raises the cap under Manage workspace → Usage.",
    );
    expect(upstream).toHaveLength(1);
    const [usage] = await db.select().from(usageDaily);
    expect(usage).toMatchObject({ calls: 1 });
    // The standing went to the bus after the answer: cap.reached and
    // app.paused_cap, once (docs/design/2026-10-events-out.md, section 5).
    await settle();
    const emitted = (await db.select().from(events)).filter((event) =>
      ["cap.reached", "app.paused_cap"].includes(event.type),
    );
    expect(
      emitted.map((event) => ({
        type: event.type,
        data: JSON.parse(event.data) as Record<string, unknown>,
      })),
    ).toEqual([
      {
        type: "cap.reached",
        data: expect.objectContaining({ cap: 1, calls: 1, source: "app" }),
      },
      {
        type: "app.paused_cap",
        data: expect.objectContaining({ cap: 1, calls: 1 }),
      },
    ]);
  });
});

describe("the provider row", () => {
  it("is on tier provider with no hostname or Worker", async () => {
    const [row] = await db.select().from(apps).where(eq(apps.id, rowId));
    expect(row).toMatchObject({
      tier: PROVIDER_APP_TIER,
      hostname: null,
      workerName: null,
      status: "active",
    });
  });
});
