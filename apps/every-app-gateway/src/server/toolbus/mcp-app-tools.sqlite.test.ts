/**
 * The MCP app tools (`everyapp_mcp_*`) on the gateway's own /mcp against a
 * migrated SQLite database, with fake remote MCP servers behind the
 * in-process remote app (setRemoteUpstreamFetchForTests, as
 * remote-mcp.sqlite.test.ts stands them in): an admin adds a server with
 * no credential and sees it listed with its tools, served on /mcp; a
 * member sees none of the tools and a call is unknown; a read-only admin
 * sees list and show alone; a credentialed server's answer names the
 * command and never a value; a tool turned off shows off; off hides the
 * tools and on brings them back; refresh says what changed; remove is the
 * owners' and asks confirm; every call leaves one audit row under app
 * `everyapp`. Drives serveGatewayMcp with resolved callers, as
 * workspace-tools.sqlite.test.ts does.
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
import { planProviderAppOn } from "@every-app/perimeter/registry";
import { MCP_APP_TOOLS, type McpPrincipal } from "@every-app/toolbus";
import { apps, remoteMcpCredentials, userAppAccess } from "@/db/schema";
import { clearAppCapCache } from "@/server/app-cap";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import type { McpCaller } from "@/server/mcp-auth/validate";
import { resetRemoteMcpBindingsForTests } from "@/server/remote-mcp/bind";
import {
  resetRemoteMcpForTests,
  setRemoteUpstreamFetchForTests,
} from "@/server/remote-mcp";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "@/server/repositories/McpToolCallRepository";
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
/** A server that takes no credential. */
const OPEN = "https://open.example/mcp";
/** A server that takes a bearer token. */
const TREG = "https://treg.example/mcp/";
const TOKEN = "treg-live-key-0123456789";

const MCP_NAMES = MCP_APP_TOOLS.map((tool) => `everyapp_${tool.name}`);

interface UpstreamTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const tool = (
  name: string,
  annotations?: UpstreamTool["annotations"],
): UpstreamTool => ({
  name,
  description: `${name} upstream.`,
  inputSchema: { type: "object", properties: {} },
  ...(annotations ? { annotations } : {}),
});

const TREG_TOOLS = [tool("getUser", { readOnlyHint: true }), tool("sendMail")];

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
/** What the open server lists; a test changes it to see a refresh. */
let openTools: UpstreamTool[];
/** The open server answers 503 to everything. */
let openDown: boolean;
/** Every request the fake servers saw: where, and with which credential. */
let seen: { host: string; method: string; authorization: string | null }[];

/** The fake remote servers, both in the 2026-07-28 era. */
async function fakeUpstream(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(input, init);
  const body = (await request.json()) as Record<string, unknown>;
  const host = new URL(request.url).host;
  const authorization = request.headers.get("authorization");
  seen.push({ host, method: String(body["method"]), authorization });
  if (host === "treg.example" && authorization !== `Bearer ${TOKEN}`) {
    return new Response("who are you", { status: 401 });
  }
  if (host === "open.example" && openDown) {
    return new Response("down for maintenance", { status: 503 });
  }
  const id = body["id"];
  if (body["method"] === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: { tools: host === "treg.example" ? TREG_TOOLS : openTools },
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "nope" },
  });
}

async function settle(): Promise<void> {
  while (hoisted.background.length) {
    await Promise.all(hoisted.background.splice(0));
  }
}

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
const member = () => callerFor(memberId, "member");
const readOnlyAdmin = () =>
  admin({
    access: "read",
    credential: { kind: "oauth", id: "mcpc_ro", clientName: "Claude" },
  });

/** A 2026-07-28 request to the gateway's /mcp. */
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

/** Every tool the caller is listed, the gateway's and the apps'. */
async function toolNames(as: McpCaller): Promise<string[]> {
  const response = await mcp("tools/list", {}, as);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return body.result.tools.map((listed) => listed.name);
}

const mcpTools = async (as: McpCaller) =>
  (await toolNames(as)).filter((name) => MCP_NAMES.includes(name));
const openTools$ = async (as: McpCaller) =>
  (await toolNames(as)).filter((name) => name.startsWith("open_"));

type Answer =
  | { ok: true; data: Record<string, unknown>; text: string }
  | { ok: false; error: string }
  | { ok: false; unknown: true; message: string };

/** Call a tool and read its answer: data, a tool error, or Unknown tool. */
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

/** The answer's data, failing the test on a refusal. */
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

async function activityRows() {
  const page = await McpToolCallRepository.listForOrganization({
    organizationId,
    limit: TOOL_CALL_PAGE_MAX,
  });
  return page.calls;
}

/** Add the open server as the admin, its tools listed in the same call. */
const addOpen = () =>
  data("everyapp_mcp_add", { url: OPEN, auth: { kind: "none" } }, admin());

type ListedApp = Record<string, unknown> & { id: string };
async function listedApps(as: McpCaller = admin()): Promise<ListedApp[]> {
  return (await data("everyapp_mcp_list", {}, as))["apps"] as ListedApp[];
}

type ShownTool = Record<string, unknown> & { serverName: string };
async function shownTools(app: string): Promise<ShownTool[]> {
  return (await data("everyapp_mcp_show", { app }, admin()))[
    "tools"
  ] as ShownTool[];
}

beforeAll(async () => {
  await import("@every-app/toolbus");
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
    APP_BASE_DOMAIN: "apps.example.com",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKeyPem,
    JWT_PUBLIC_KEY: keys.publicKeyPem,
    DB: {},
  });
  hoisted.background.length = 0;
  db = await createTestDb();
  hoisted.testDb.current = db;
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
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetToolBusForTests();
  resetRemoteMcpForTests();
  resetRemoteMcpBindingsForTests();
  clearAppCapCache();
  openTools = [
    tool("search", { readOnlyHint: true }),
    tool("fetchPage"),
    tool("dropIndex", { destructiveHint: true }),
  ];
  openDown = false;
  seen = [];
  setRemoteUpstreamFetchForTests(fakeUpstream as typeof fetch);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  await settle();
  setRemoteUpstreamFetchForTests(undefined);
  vi.restoreAllMocks();
});

describe("an admin managing MCP apps over /mcp", () => {
  it("adds a server with no credential, lists it with its tools, shows each one, and serves them on /mcp", async () => {
    const added = await addOpen();
    expect(added).toMatchObject({
      id: "open",
      name: "open",
      url: OPEN,
      auth: "none",
      credential: null,
      tools: 3,
      next: "Its tools are on /mcp as open_<tool>.",
    });
    expect(added).not.toHaveProperty("setupCommand");

    expect(await listedApps()).toEqual([
      {
        id: "open",
        rowId: added["rowId"],
        name: "open",
        kind: "remote",
        status: "on",
        tools: 3,
        url: OPEN,
        auth: "none",
        risk: "annotations",
        supported: true,
        credential: null,
        listedAt: expect.any(String),
      },
    ]);

    const shown = await data("everyapp_mcp_show", { app: "open" }, admin());
    expect(shown["app"]).toMatchObject({
      id: "open",
      kind: "remote",
      status: "on",
      url: OPEN,
      auth: "none",
      authLabel: "no credential",
      description: expect.stringContaining("open.example"),
    });
    expect(shown["tools"]).toEqual([
      {
        name: "open_drop_index",
        serverName: "dropIndex",
        title: null,
        risk: "destructive",
        source: "hint",
        on: true,
        listed: true,
      },
      {
        name: "open_fetch_page",
        serverName: "fetchPage",
        title: null,
        risk: "write",
        source: "default",
        on: true,
        listed: true,
      },
      {
        name: "open_search",
        serverName: "search",
        title: null,
        risk: "read",
        source: "hint",
        on: true,
        listed: true,
      },
    ]);
    // The row id names it as well as the id.
    expect(
      (
        await data(
          "everyapp_mcp_show",
          { app: added["rowId"] as string },
          admin(),
        )
      )["app"],
    ).toMatchObject({ id: "open" });

    // Served on /mcp to the admin who added it (a destructive tool never is).
    expect(await openTools$(admin())).toEqual([
      "open_fetch_page",
      "open_search",
    ]);
    // The server saw tools/list, never a credential.
    expect(seen.every((request) => request.authorization === null)).toBe(true);
    expect(seen.map((request) => request.method)).toContain("tools/list");
  });

  it("says what isn't an MCP app here: a deployed app, an unknown id, a built-in never added", async () => {
    await deployLiveApp(db, {
      organizationId,
      appSlug: "crm",
      name: "CRM",
      description: "The CRM app",
      manifest: { id: "crm", name: "CRM" },
      deployerUserId: ownerId,
      appBaseDomain: "gateway.example.com",
    });
    expect(await refusal("everyapp_mcp_show", { app: "crm" }, admin())).toBe(
      'APP_NOT_FOUND: No MCP app "crm" here',
    );
    expect(await refusal("everyapp_mcp_off", { app: "nope" }, admin())).toBe(
      'APP_NOT_FOUND: No MCP app "nope" here',
    );
    expect(
      await refusal("everyapp_mcp_on", { app: "dataforseo" }, admin()),
    ).toBe(
      "APP_NOT_FOUND: DataForSEO isn't added here; the operator adds it with pnpm everyapp mcp on dataforseo",
    );
    expect(await listedApps()).toEqual([]);
  });

  it("lists an added built-in as needing its key, names the command, and refuses a tool override on it", async () => {
    const plan = planProviderAppOn({
      organizationId,
      id: "dataforseo",
      existingApp: null,
      members: [
        { id: ownerId, role: "owner" },
        { id: adminId, role: "admin" },
      ],
      actorUserId: ownerId,
      actor: "owner@example.com",
      now: Date.now(),
    });
    await db.insert(apps).values({
      ...plan.app,
      deployedAt: new Date(plan.app.deployedAt ?? Date.now()),
    });
    for (const grant of plan.grants) {
      await db.insert(userAppAccess).values(grant);
    }
    expect(await listedApps()).toEqual([
      {
        id: "dataforseo",
        rowId: plan.app.id,
        name: "DataForSEO",
        kind: "builtin",
        status: "needs setup",
        // The /mcp request itself took its snapshot (first use).
        tools: expect.any(Number),
        listedAt: expect.any(String),
        credential: {
          name: "DATAFORSEO_API_KEY",
          set: false,
          state: "not_set",
        },
        setupCommand: "pnpm everyapp secret set DATAFORSEO_API_KEY",
      },
    ]);
    expect(
      await refusal(
        "everyapp_mcp_tool",
        { app: "dataforseo", tool: "keyword_metrics", enabled: false },
        admin(),
      ),
    ).toBe(
      `APP_NOT_FOUND: "dataforseo" is the Gateway's built-in MCP app, not a remote server.`,
    );
    // Off and on work for either kind.
    expect(
      await data("everyapp_mcp_off", { app: "dataforseo" }, admin()),
    ).toMatchObject({ status: "off", changed: true });
    expect((await listedApps())[0]).toMatchObject({ status: "off" });
  });

  it("adds a credentialed server with the command that sets it, never a value, and shows it bound once set", async () => {
    const added = await data(
      "everyapp_mcp_add",
      { url: TREG, name: "Treg", auth: { kind: "bearer" } },
      admin(),
    );
    expect(added).toEqual({
      id: "treg",
      rowId: expect.any(String),
      name: "Treg",
      url: TREG,
      auth: "bearer",
      credential: { name: "TREG_MCP_TOKEN", set: false },
      tools: null,
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      next: "The operator runs the command in a terminal and types the credential there, never into a chat. The Gateway lists the tools once it is set.",
    });
    expect(await listedApps()).toEqual([
      expect.objectContaining({
        id: "treg",
        status: "needs setup",
        tools: null,
        auth: "bearer",
        credential: {
          name: "TREG_MCP_TOKEN",
          set: false,
          bound: false,
          state: "not_set",
        },
        setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      }),
    ]);
    // Nothing reached the server without its credential, and no tool is served.
    expect(seen).toEqual([]);
    expect(
      (await toolNames(admin())).filter((name) => name.startsWith("treg_")),
    ).toEqual([]);

    // A value where the name goes is refused without being echoed.
    const refused = await refusal(
      "everyapp_mcp_add",
      {
        url: "https://other.example/mcp",
        auth: { kind: "bearer", secret: "sk-live-abcdef" },
      },
      admin(),
    );
    expect(refused).toMatch(/^REMOTE_MCP_INVALID: /);
    expect(refused).not.toContain("sk-live-abcdef");

    // The operator sets it (a new isolate reads the new setting); the
    // refresh lists through it and binds it to the server's origin.
    hoisted.env["TREG_MCP_TOKEN"] = TOKEN;
    resetAppSetupCacheForTests();
    expect(
      await data("everyapp_mcp_refresh", { app: "treg" }, admin()),
    ).toMatchObject({
      id: "treg",
      status: "ok",
      tools: 2,
      added: ["treg_get_user", "treg_send_mail"],
      removed: [],
    });
    const [binding] = await db
      .select()
      .from(remoteMcpCredentials)
      .where(eq(remoteMcpCredentials.name, "TREG_MCP_TOKEN"));
    expect(binding?.origin).toBe("https://treg.example");
    const shown = await data("everyapp_mcp_show", { app: "treg" }, admin());
    expect(shown["app"]).toMatchObject({
      status: "on",
      credential: {
        name: "TREG_MCP_TOKEN",
        set: true,
        bound: true,
        state: "bound",
      },
    });
    expect(shown["app"]).not.toHaveProperty("setupCommand");
    const listed = await data("everyapp_mcp_list", {}, admin());
    // The value went to the server alone: no answer and no audit row has it.
    expect(seen.some((request) => request.authorization?.includes(TOKEN))).toBe(
      true,
    );
    expect(JSON.stringify([added, shown, listed])).not.toContain(TOKEN);
    expect(JSON.stringify(await activityRows())).not.toContain(TOKEN);

    // Removed, the credential stays set: the answer names who unsets it.
    const removed = await data(
      "everyapp_mcp_remove",
      { app: "treg", confirm: true },
      owner(),
    );
    expect(removed["note"]).toBe(
      "Its access, tokens, tools snapshot and place in AI connections are gone. TREG_MCP_TOKEN stays set on the Gateway; the operator unsets it with pnpm everyapp secret unset TREG_MCP_TOKEN.",
    );
    expect(JSON.stringify(removed)).not.toContain(TOKEN);
  });

  it("turns one tool off and changes another's risk, by either name, and show reflects both", async () => {
    await addOpen();
    expect(
      await data(
        "everyapp_mcp_tool",
        { app: "open", tool: "open_search", enabled: false },
        admin(),
      ),
    ).toMatchObject({
      id: "open",
      tool: { serverName: "search", name: "open_search", inListing: true },
      override: { enabled: false },
      rev: 2,
    });
    await data(
      "everyapp_mcp_tool",
      { app: "open", tool: "fetchPage", risk: "read" },
      admin(),
    );
    const byName = Object.fromEntries(
      (await shownTools("open")).map((shown) => [shown.serverName, shown]),
    );
    expect(byName["search"]).toMatchObject({ on: false });
    expect(byName["fetchPage"]).toMatchObject({
      risk: "read",
      source: "override",
      on: true,
    });
    // The Gateway lists again on first use, and leaves the tool out.
    expect(await openTools$(admin())).toEqual(["open_fetch_page"]);

    // annotations clears the risk override; enabled true serves it again.
    await data(
      "everyapp_mcp_tool",
      { app: "open", tool: "open_fetch_page", risk: "annotations" },
      admin(),
    );
    const cleared = await data(
      "everyapp_mcp_tool",
      { app: "open", tool: "search", enabled: true },
      admin(),
    );
    expect(cleared["override"]).toBeNull();
    const after = Object.fromEntries(
      (await shownTools("open")).map((shown) => [shown.serverName, shown]),
    );
    expect(after["fetchPage"]).toMatchObject({
      risk: "write",
      source: "default",
    });
    expect(after["search"]).toMatchObject({ on: true });

    // A name the server doesn't list is kept under it, and said so.
    expect(
      await data(
        "everyapp_mcp_tool",
        { app: "open", tool: "laterTool", enabled: false },
        admin(),
      ),
    ).toMatchObject({
      tool: { serverName: "laterTool", name: null, inListing: false },
      note: expect.stringContaining("no tool by that name"),
    });
    expect(
      await refusal("everyapp_mcp_tool", { app: "open", tool: "x" }, admin()),
    ).toBe("INVALID_INPUT: Give risk, enabled, or both");
  });

  it("stops serving the tools when off and brings them back when on, keeping access", async () => {
    await addOpen();
    expect(await openTools$(admin())).toEqual([
      "open_fetch_page",
      "open_search",
    ]);
    expect(
      await data("everyapp_mcp_off", { app: "open" }, admin()),
    ).toMatchObject({ id: "open", status: "off", changed: true });
    expect(await openTools$(admin())).toEqual([]);
    expect((await listedApps())[0]).toMatchObject({ status: "off", tools: 3 });
    const grants = await db
      .select()
      .from(userAppAccess)
      .where(eq(userAppAccess.userId, adminId));
    expect(grants.length).toBeGreaterThan(0);

    expect(
      await data("everyapp_mcp_on", { app: "open" }, admin()),
    ).toMatchObject({ id: "open", status: "on", changed: true, tools: 3 });
    expect(await openTools$(admin())).toEqual([
      "open_fetch_page",
      "open_search",
    ]);
    expect(
      await data("everyapp_mcp_on", { app: "open" }, admin()),
    ).toMatchObject({ changed: false });
  });

  it("lists the tools again on refresh and says which names are new and which are gone", async () => {
    await addOpen();
    openTools = [tool("search", { readOnlyHint: true }), tool("summarize")];
    expect(
      await data("everyapp_mcp_refresh", { app: "open" }, admin()),
    ).toEqual({
      id: "open",
      rowId: expect.any(String),
      name: "open",
      status: "ok",
      tools: 2,
      added: ["open_summarize"],
      removed: ["open_drop_index", "open_fetch_page"],
    });
    expect(await openTools$(admin())).toEqual([
      "open_search",
      "open_summarize",
    ]);

    // A server that can't be reached: the answer says so, and is no refusal.
    openDown = true;
    const failed = await data("everyapp_mcp_refresh", { app: "open" }, admin());
    expect(failed).toMatchObject({
      id: "open",
      status: "error",
      problem: expect.any(String),
    });
    expect(JSON.stringify(failed)).not.toContain("down for maintenance");
    expect((await listedApps())[0]).toMatchObject({
      status: "on",
      tools: null,
      lastError: expect.any(String),
    });
  });
});

describe("who may manage MCP apps over /mcp", () => {
  it("lists a member no MCP app tool, and answers each as unknown", async () => {
    await addOpen();
    const before = (await activityRows()).length;
    expect(await mcpTools(member())).toEqual([]);
    for (const name of MCP_NAMES) {
      expect(await call(name, { app: "open" }, member()), name).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
    }
    const rows = (await activityRows()).slice(0, MCP_NAMES.length);
    expect(await activityRows()).toHaveLength(before + MCP_NAMES.length);
    for (const row of rows) {
      expect(row).toMatchObject({
        decision: "blocked",
        reason: "role_required",
        app: { slug: "everyapp" },
      });
    }
    // Still on, still there.
    expect((await listedApps())[0]).toMatchObject({ status: "on" });
  });

  it("lists a read-only admin connection list and show alone; a write is unknown", async () => {
    await addOpen();
    expect(await mcpTools(readOnlyAdmin())).toEqual([
      "everyapp_mcp_list",
      "everyapp_mcp_show",
    ]);
    expect(await listedApps(readOnlyAdmin())).toHaveLength(1);
    expect(
      await call("everyapp_mcp_off", { app: "open" }, readOnlyAdmin()),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_mcp_off",
    });
    expect((await activityRows())[0]).toMatchObject({
      tool: { name: "everyapp_mcp_off" },
      decision: "blocked",
      reason: "read_only_connection",
    });
    expect((await listedApps())[0]).toMatchObject({ status: "on" });
  });

  it("lists all eight MCP app tools to an admin as to the owner", async () => {
    expect(await mcpTools(admin())).toEqual(MCP_NAMES);
    expect(await mcpTools(owner())).toEqual(MCP_NAMES);
  });

  it("removes an MCP app for an owner or an admin, with confirm: the tombstone; a member finds no such tool", async () => {
    const added = await addOpen();
    expect(
      await call(
        "everyapp_mcp_remove",
        { app: "open", confirm: true },
        member(),
      ),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_mcp_remove",
    });
    expect(
      await refusal("everyapp_mcp_remove", { app: "open" }, owner()),
    ).toMatch(/^Invalid arguments for everyapp_mcp_remove: /);
    expect(
      await refusal(
        "everyapp_mcp_remove",
        { app: "open", confirm: false },
        owner(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_mcp_remove: /);
    expect(await listedApps()).toHaveLength(1);

    expect(
      await data(
        "everyapp_mcp_remove",
        { app: "open", confirm: true },
        owner(),
      ),
    ).toEqual({
      removed: {
        id: "open",
        rowId: added["rowId"],
        name: "open",
        kind: "remote",
      },
      note: "Its access, tokens, tools snapshot and place in AI connections are gone.",
    });
    expect(await listedApps()).toEqual([]);
    expect(await openTools$(owner())).toEqual([]);
    expect(await refusal("everyapp_mcp_show", { app: "open" }, owner())).toBe(
      'APP_NOT_FOUND: No MCP app "open" here',
    );
    const grants = await db
      .select()
      .from(userAppAccess)
      .where(eq(userAppAccess.appRowId, added["rowId"] as string));
    expect(grants).toEqual([]);
    // Added again from its URL, it comes back on its old row.
    expect(await addOpen()).toMatchObject({
      rowId: added["rowId"],
      revived: true,
    });
  });

  it("leaves one audit row under app everyapp for every call", async () => {
    await addOpen();
    await data("everyapp_mcp_list", {}, admin());
    await data("everyapp_mcp_show", { app: "open" }, admin());
    await data(
      "everyapp_mcp_tool",
      { app: "open", tool: "search", risk: "write" },
      admin(),
    );
    await data("everyapp_mcp_refresh", { app: "open" }, admin());
    await data("everyapp_mcp_off", { app: "open" }, admin());
    await data("everyapp_mcp_on", { app: "open" }, admin());
    await data("everyapp_mcp_remove", { app: "open", confirm: true }, owner());
    const rows = await activityRows();
    expect(rows.map((row) => row.tool.name).reverse()).toEqual([
      "everyapp_mcp_add",
      "everyapp_mcp_list",
      "everyapp_mcp_show",
      "everyapp_mcp_tool",
      "everyapp_mcp_refresh",
      "everyapp_mcp_off",
      "everyapp_mcp_on",
      "everyapp_mcp_remove",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        app: { slug: "everyapp", rowId: null },
        decision: "allowed",
        outcome: "ok",
        tool: {
          via: null,
          risk: ["everyapp_mcp_list", "everyapp_mcp_show"].includes(
            row.tool.name,
          )
            ? "read"
            : "write",
        },
      });
    }
    expect(rows[0]!.user).toMatchObject({ id: ownerId });
    expect(rows.at(-1)!.user).toMatchObject({ id: adminId });
  });
});
