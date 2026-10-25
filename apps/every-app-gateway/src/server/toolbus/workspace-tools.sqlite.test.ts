/**
 * The workspace tools on the gateway's own /mcp against a migrated SQLite
 * database: an admin with a read & write connection runs every admin
 * action of the UI (invite, role, groups, app access, caps, the reads) and
 * each call leaves one `mcp_tool_calls` row Admin → Activity lists; a
 * read-only admin lists the read tools and cannot write; a member sees
 * none of the admin tools and only their own; an owner-only tool refuses
 * an admin; the irreversible tools ask confirm; no answer carries a
 * credential. Drives serveGatewayMcp with resolved callers, as
 * gateway-mcp.sqlite.test.ts does.
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
import {
  defineTools,
  everyApp,
  type PlainToolSchema,
} from "@every-app/sdk/server";
import {
  WORKSPACE_ACTIVITY_PAGE_MAX,
  WORKSPACE_EVENT_DELIVERIES_PAGE_MAX,
  WORKSPACE_TOOLS,
  type McpPrincipal,
} from "@every-app/toolbus";
import { INVITATION_LIMIT } from "@/auth/config";
import {
  eventDeliveries,
  eventSubscriptions,
  invitations,
  organizations,
  users,
  verifications,
} from "@/db/schema";
import { resetAppSetupCacheForTests } from "@/server/app-setup";
import {
  setDeliveryDepsForTests,
  type DeliveryDeps,
} from "@/server/events/deliver";
import type { EventMailer } from "@/server/events/email-sink";
import { clearEventSubjectCachesForTests } from "@/server/events/subjects";
import {
  DELIVERIES_PAGE_MAX,
  EventSubscriptionService,
} from "@/server/events/subscriptions";
import {
  resolveOauthCaller,
  resolvePatCaller,
  type McpCaller,
} from "@/server/mcp-auth/validate";
import { GroupRepository } from "@/server/repositories/GroupRepository";
import { McpConnectionRepository } from "@/server/repositories/McpConnectionRepository";
import {
  McpToolCallRepository,
  TOOL_CALL_PAGE_MAX,
} from "@/server/repositories/McpToolCallRepository";
import { UserPatService } from "@/server/services/UserPatService";
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

const WORKSPACE_NAMES = WORKSPACE_TOOLS.map((tool) => `everyapp_${tool.name}`);
const ADMIN_NAMES = WORKSPACE_TOOLS.filter(
  (tool) => tool.minRole !== "member",
).map((tool) => `everyapp_${tool.name}`);
const MEMBER_NAMES = WORKSPACE_TOOLS.filter(
  (tool) => tool.minRole === "member",
).map((tool) => `everyapp_${tool.name}`);

let keys: { privateKeyPem: string; publicKeyPem: string };
let db: TestDb;
let organizationId: string;
let ownerId: string;
let adminId: string;
let memberId: string;
let crmRowId: string;

/**
 * Deploy an app live (Acme's by default), with its Worker bound and its
 * tools synced.
 */
async function deploy(
  appSlug: string,
  name: string,
  owner: { organizationId: string; userId: string } = {
    organizationId,
    userId: ownerId,
  },
): Promise<string> {
  const { app } = await deployLiveApp(db, {
    organizationId: owner.organizationId,
    appSlug,
    name,
    description: `The ${name} app`,
    manifest: { id: appSlug, name },
    deployerUserId: owner.userId,
    appBaseDomain: "gateway.example.com",
  });
  // One read tool, so the app serves a catalog and lists on /mcp.
  const input: PlainToolSchema<Record<string, never>> = {
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: (value) => ({ value: value as Record<string, never> }),
  };
  const worker = everyApp(
    async () => new Response(`${appSlug} page`),
    {
      id: appSlug,
    },
    {
      publicKeys: [keys.publicKeyPem],
      issuer: GATEWAY,
      tools: defineTools({
        ping: {
          description: "Ping.",
          risk: "read",
          input,
          handler: () => "pong",
        },
      }),
    },
  );
  hoisted.env[`APP__${app.workerName}`] = {
    fetch: (request: Request) =>
      worker.fetch(request, { EVERYAPP_AUDIENCE: app.workerName }, {
        waitUntil: () => undefined,
      } as unknown as ExecutionContext),
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
  return app.id;
}

/** A resolved caller, failing the test when the credential was refused. */
function callerOf(
  resolved: McpCaller | "insufficient_scope" | null,
): McpCaller {
  if (!resolved || resolved === "insufficient_scope") {
    throw new Error(`the credential was refused: ${String(resolved)}`);
  }
  return resolved;
}

/** A pending invitation row, as Better Auth or the session-less path writes it. */
function pendingInvitation(
  id: string,
  email: string,
  options: {
    organizationId?: string;
    inviterId?: string;
    expiresAt?: Date;
  } = {},
) {
  return {
    id,
    organizationId: options.organizationId ?? organizationId,
    email,
    role: "member",
    status: "pending",
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    inviterId: options.inviterId ?? adminId,
  };
}

/** One audit row an app tool call left, as the ToolBus writes it. */
function auditRow(input: {
  callId: string;
  organizationId: string;
  userId: string;
  tool: string;
  appId: string;
  appRowId: string;
}) {
  return McpToolCallRepository.insert({
    surface: "gateway",
    tool: input.tool,
    appId: input.appId,
    appRowId: input.appRowId,
    risk: "read",
    decision: "allowed",
    outcome: "ok",
    durationMs: 1,
    callId: input.callId,
    userId: input.userId,
    organizationId: input.organizationId,
    credentialKind: "pat",
    credentialId: "pat_x",
  });
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

/** A 2026-07-28 request to the gateway's /mcp. */
function mcp(
  method: string,
  params: Record<string, unknown>,
  as: McpCaller,
  query = "",
): Promise<Response> {
  const name = typeof params["name"] === "string" ? params["name"] : null;
  return serveGatewayMcp(
    new Request(`${GATEWAY}/mcp${query}`, {
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

/** The audit rows are written after the response; wait for them. */
async function settle(): Promise<void> {
  await Promise.all(
    hoisted.waitUntil.mock.calls.map(([task]) => Promise.resolve(task)),
  );
}

async function toolNames(as: McpCaller, query = ""): Promise<string[]> {
  const response = await mcp("tools/list", {}, as, query);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: { tools: { name: string }[] };
  };
  await settle();
  return body.result.tools
    .map((tool) => tool.name)
    .filter((name) => WORKSPACE_NAMES.includes(name));
}

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
  vi.restoreAllMocks();
});

beforeEach(async () => {
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
  hoisted.waitUntil.mockReset();
  clearCatalogSyncClaimsForTests();
  resetAppSetupCacheForTests();
  resetToolBusForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  crmRowId = await deploy("crm", "CRM");
});

describe("who sees which workspace tools", () => {
  it("lists every admin tool and the member's own to an admin with write access, in full mode only", async () => {
    expect(await toolNames(admin())).toEqual(
      WORKSPACE_TOOLS.filter((tool) => tool.minRole !== "owner").map(
        (tool) => `everyapp_${tool.name}`,
      ),
    );
    expect(await toolNames(owner())).toEqual(WORKSPACE_NAMES);
    expect(await toolNames(owner(), "?tools=compact")).toEqual([]);
  });

  it("lists the read tools alone to a read-only admin, who cannot invite: the tool is unknown", async () => {
    const readOnly = admin({
      access: "read",
      credential: { kind: "oauth", id: "mcpc_ro", clientName: "Claude" },
    });
    const listed = await toolNames(readOnly);
    expect(listed).toContain("everyapp_workspace_users");
    expect(listed).toContain("everyapp_workspace_show");
    expect(listed).not.toContain("everyapp_workspace_invite");
    expect(listed).toEqual(
      WORKSPACE_TOOLS.filter(
        (tool) => tool.risk === "read" && tool.minRole !== "owner",
      ).map((tool) => `everyapp_${tool.name}`),
    );
    // Reads work: a member carries their account's creation and when they
    // joined this organization.
    expect(await data("everyapp_workspace_users", {}, readOnly)).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          email: "member@example.com",
          createdAt: expect.any(String),
          joinedAt: expect.any(String),
        }),
      ]),
    });
    // A write is unknown, not refused: nothing about it leaks.
    const answer = await call(
      "everyapp_workspace_invite",
      { email: "new@example.com" },
      readOnly,
    );
    expect(answer).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_workspace_invite",
    });
    const rows = await activityRows();
    expect(rows[0]).toMatchObject({
      tool: { name: "everyapp_workspace_invite", via: null },
      decision: "blocked",
      reason: "read_only_connection",
      credential: { kind: "oauth", clientName: "Claude" },
    });
    expect(await db.select().from(invitations)).toEqual([]);
  });

  it("lists a member nothing but their own four, and answers the admin tools as unknown", async () => {
    expect(await toolNames(member())).toEqual(MEMBER_NAMES);
    for (const name of ADMIN_NAMES) {
      const answer = await call(name, {}, member());
      expect(answer, name).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
    }
    const rows = await activityRows();
    expect(rows).toHaveLength(ADMIN_NAMES.length);
    for (const row of rows) {
      expect(row).toMatchObject({
        decision: "blocked",
        reason: "role_required",
        app: { slug: "everyapp" },
      });
    }
    // And through the search, nothing of the admin's (the provider tools
    // are provider-tools.sqlite.test.ts's).
    const found = await data(
      "everyapp_search_tools",
      { app: "everyapp", limit: 25 },
      member(),
    );
    expect(
      (found["tools"] as { name: string }[])
        .map((tool) => tool.name)
        .filter((name) => WORKSPACE_NAMES.includes(name))
        .sort(),
    ).toEqual([...MEMBER_NAMES].sort());
  });

  it("refuses an admin the owner-only tools as unknown, and runs them for the owner only with confirm", async () => {
    expect(
      await call(
        "everyapp_workspace_remove",
        { user: "member@example.com", confirm: true },
        admin(),
      ),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_workspace_remove",
    });
    // The owner without confirm: the schema refuses it before anything runs.
    expect(
      await refusal(
        "everyapp_workspace_remove",
        { user: "member@example.com" },
        owner(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_workspace_remove: /);
    expect(
      await refusal(
        "everyapp_workspace_remove",
        { user: "member@example.com", confirm: false },
        owner(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_workspace_remove: /);
    expect(
      (await data("everyapp_workspace_users", {}, owner()))["members"],
    ).toHaveLength(3);
    // With it, the member goes.
    expect(
      await data(
        "everyapp_workspace_remove",
        { user: "member@example.com", confirm: true },
        owner(),
      ),
    ).toMatchObject({
      user: { id: memberId, email: "member@example.com" },
      removed: true,
      deactivatedInstead: false,
    });
    expect(
      (await data("everyapp_workspace_users", {}, owner()))["members"],
    ).toHaveLength(2);
    // Never yourself: the service's own rules come back as errors.
    expect(
      await refusal(
        "everyapp_workspace_remove",
        { user: "owner@example.com", confirm: true },
        owner(),
      ),
    ).toMatch(/^CANNOT_MANAGE_SELF: /);
  });

  it("hides every workspace tool from a credential narrowed to apps, whatever the role: a token bound to one app, a connection consented to some", async () => {
    await data(
      "everyapp_workspace_app_access_set",
      { app: "crm", add: ["admin@example.com"] },
      owner(),
    );
    // The admin's personal token bound to crm, and their OAuth connection
    // consented to "Only these apps", each resolved as /mcp resolves it.
    const bound = await UserPatService.create({
      userId: adminId,
      organizationId,
      name: "ci",
      scopes: ["mcp:read", "mcp:write"],
      appRowId: crmRowId,
    });
    const token = callerOf(await resolvePatCaller(bound.plaintext));
    expect(token).toMatchObject({
      kind: "caller",
      principal: { orgRole: "admin", access: "write" },
      apps: { appRowId: crmRowId },
    });
    await McpConnectionRepository.create({
      id: "mcpc_crm",
      userId: adminId,
      organizationId,
      clientId: "https://claude.ai/client",
      clientName: "Claude",
      clientDomain: "claude.ai",
      redirectUri: "https://claude.ai/callback",
      redirectHost: "claude.ai",
      appScope: "selected",
      appRowIds: [crmRowId],
      access: "write",
      createdAt: new Date(),
    });
    const connection = callerOf(
      await resolveOauthCaller(
        {
          v: 1,
          kind: "oauth",
          connectionId: "mcpc_crm",
          userId: adminId,
          organizationId,
        },
        ["mcp:read", "mcp:write"],
      ),
    );
    expect(connection).toMatchObject({
      kind: "caller",
      principal: { orgRole: "admin", access: "write" },
      apps: { connectionId: "mcpc_crm" },
    });

    for (const caller of [token, connection]) {
      if (caller.kind !== "caller") throw new Error("refused");
      const kind = caller.principal.credential.kind;
      // Nothing listed, in full mode, to an admin with write access.
      expect(await toolNames(caller), kind).toEqual([]);
      // The app the credential is for is served as ever.
      expect(
        (
          (await data("everyapp_list_apps", {}, caller))["apps"] as {
            id: string;
          }[]
        ).map((app) => app.id),
        kind,
      ).toEqual(["crm"]);
      // The search knows none of them.
      expect(
        (
          await data(
            "everyapp_search_tools",
            { app: "everyapp", limit: 25 },
            caller,
          )
        )["tools"],
        kind,
      ).toEqual([]);
      // A call answers Unknown tool, the member's own tools included,
      // audited blocked with the reason.
      for (const [name, args] of [
        ["everyapp_workspace_users", {}],
        ["everyapp_workspace_invite", { email: "x@example.com" }],
        ["everyapp_my_tokens", {}],
      ] as const) {
        expect(await call(name, args, caller), `${kind} ${name}`).toEqual({
          ok: false,
          unknown: true,
          message: `Unknown tool: ${name}`,
        });
        expect((await activityRows())[0], `${kind} ${name}`).toMatchObject({
          tool: { name },
          decision: "blocked",
          reason: "app_scoped_credential",
          credential: { kind },
        });
      }
    }
    expect(await db.select().from(invitations)).toEqual([]);
    // The same admin through a credential for every app sees them.
    expect(await toolNames(admin())).not.toEqual([]);
  });
});

describe("an admin administering the workspace over /mcp", () => {
  it("shows the workspace and its counts", async () => {
    expect(await data("everyapp_workspace_show", {}, admin())).toEqual({
      organization: { id: organizationId, name: "acme", slug: "acme" },
      role: "admin",
      email: { configured: false },
      counts: { members: 3, pendingInvitations: 0, groups: 0, apps: 1 },
    });
  });

  it("invites without ever returning the link, lists and cancels the invitation", async () => {
    const invited = await data(
      "everyapp_workspace_invite",
      { email: "New@Example.com", role: "admin" },
      admin(),
    );
    expect(invited).toMatchObject({
      invitationId: expect.any(String),
      email: "new@example.com",
      role: "admin",
      expiresAt: expect.any(String),
      emailed: false,
      next: expect.stringContaining("Admin → Users"),
    });
    const text = JSON.stringify(invited);
    expect(text).not.toContain("accept-invitation");
    expect(text).not.toContain("token=");
    expect(text).not.toContain("einv_");
    expect(text).not.toContain("http");
    // The row Better Auth would have written: pending, 72 hours, the caller as inviter.
    const [row] = await db.select().from(invitations);
    expect(row).toMatchObject({
      id: invited["invitationId"],
      organizationId,
      email: "new@example.com",
      role: "admin",
      status: "pending",
      inviterId: adminId,
    });
    const ttl = row!.expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(71 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(72 * 60 * 60 * 1000);
    // Listed with its expiry, and counted.
    const listed = await data("everyapp_workspace_users", {}, admin());
    expect(listed["invitations"]).toEqual([
      expect.objectContaining({
        id: invited["invitationId"],
        email: "new@example.com",
        role: "admin",
        expiresAt: row!.expiresAt.toISOString(),
      }),
    ]);
    expect(
      (await data("everyapp_workspace_show", {}, admin()))["counts"],
    ).toMatchObject({ pendingInvitations: 1 });
    // Twice is refused; a member is refused.
    expect(
      await refusal(
        "everyapp_workspace_invite",
        { email: "new@example.com" },
        admin(),
      ),
    ).toMatch(/^ALREADY_INVITED: /);
    expect(
      await refusal(
        "everyapp_workspace_invite",
        { email: "member@example.com" },
        admin(),
      ),
    ).toMatch(/^ALREADY_MEMBER: /);
    // Canceled by email; then gone.
    expect(
      await data(
        "everyapp_workspace_uninvite",
        { invitation: "new@example.com" },
        admin(),
      ),
    ).toEqual({
      canceled: { id: invited["invitationId"], email: "new@example.com" },
    });
    expect((await db.select().from(invitations))[0]?.status).toBe("canceled");
    expect(
      await refusal(
        "everyapp_workspace_uninvite",
        { invitation: invited["invitationId"] as string },
        admin(),
      ),
    ).toMatch(/^INVITATION_NOT_FOUND: /);
  });

  it("changes a role (member, admin and owner, by the service's rules), deactivates and reactivates", async () => {
    expect(
      await data(
        "everyapp_workspace_role",
        { user: "member@example.com", role: "admin" },
        owner(),
      ),
    ).toEqual({
      user: { id: memberId, email: "member@example.com" },
      role: "admin",
    });
    // An admin changes a member, never another admin, and makes no owner.
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: memberId, role: "member" },
        admin(),
      ),
    ).toMatch(/^OWNER_REQUIRED: /);
    expect(
      await data(
        "everyapp_workspace_role",
        { user: memberId, role: "member" },
        owner(),
      ),
    ).toMatchObject({ role: "member" });
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: memberId, role: "owner" },
        admin(),
      ),
    ).toMatch(/^OWNER_REQUIRED: /);
    // An owner makes a member an owner; the new owner demotes the first.
    expect(
      await data(
        "everyapp_workspace_role",
        { user: memberId, role: "owner" },
        owner(),
      ),
    ).toMatchObject({ role: "owner" });
    expect(
      await data(
        "everyapp_workspace_role",
        { user: "owner@example.com", role: "admin" },
        callerFor(memberId, "owner"),
      ),
    ).toMatchObject({ user: { id: ownerId }, role: "admin" });
    // They are the organization's one owner now: nobody demotes them, not
    // even a caller whose role still reads owner (the count is the
    // database's), and nobody changes their own role.
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: memberId, role: "admin" },
        owner(),
      ),
    ).toMatch(/^LAST_OWNER: /);
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: memberId, role: "admin" },
        callerFor(ownerId, "admin"),
      ),
    ).toMatch(/^OWNER_REQUIRED: /);
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: memberId, role: "admin" },
        callerFor(memberId, "owner"),
      ),
    ).toMatch(/^CANNOT_MANAGE_SELF: /);
    // With a second owner made, the first can be one again and the other
    // demoted all the way.
    expect(
      await data(
        "everyapp_workspace_role",
        { user: ownerId, role: "owner" },
        callerFor(memberId, "owner"),
      ),
    ).toMatchObject({ role: "owner" });
    expect(
      await data(
        "everyapp_workspace_role",
        { user: memberId, role: "member" },
        owner(),
      ),
    ).toMatchObject({ role: "member" });
    expect(
      await refusal(
        "everyapp_workspace_role",
        { user: "nobody@example.com", role: "admin" },
        admin(),
      ),
    ).toBe(
      'USER_NOT_FOUND: No member "nobody@example.com" in this organization',
    );

    expect(
      await data(
        "everyapp_workspace_deactivate",
        { user: "member@example.com" },
        admin(),
      ),
    ).toEqual({
      user: { id: memberId, email: "member@example.com" },
      deactivated: true,
    });
    const [banned] = await db
      .select()
      .from(users)
      .where(eq(users.id, memberId));
    expect(banned?.banned).toBe(true);
    expect(
      (
        (await data("everyapp_workspace_users", {}, admin()))["members"] as {
          id: string;
          deactivated: boolean;
        }[]
      ).find((user) => user.id === memberId)?.deactivated,
    ).toBe(true);
    expect(
      await data("everyapp_workspace_reactivate", { user: memberId }, admin()),
    ).toMatchObject({ deactivated: false });
    expect(
      (await db.select().from(users).where(eq(users.id, memberId)))[0]?.banned,
    ).toBe(false);
  });

  it("creates a group, sets its members and apps by full list and by add/remove, and deletes it", async () => {
    const created = await data(
      "everyapp_workspace_group_create",
      { name: "Sales", description: "The sales team" },
      admin(),
    );
    const group = created["group"] as { id: string; name: string };
    expect(group).toMatchObject({
      id: expect.stringMatching(/^grp_[0-9a-f]{16}$/),
      name: "Sales",
      description: "The sales team",
    });
    expect(
      await refusal(
        "everyapp_workspace_group_create",
        { name: "sales" },
        admin(),
      ),
    ).toMatch(/^GROUP_NAME_TAKEN: /);

    // Members: the full list by email, then add/remove by id, never both.
    expect(
      await data(
        "everyapp_workspace_group_members_set",
        { group: "Sales", users: ["member@example.com"] },
        admin(),
      ),
    ).toMatchObject({ group: { id: group.id }, added: 1, removed: 0 });
    expect(
      await data(
        "everyapp_workspace_group_members_set",
        { group: group.id, add: [adminId], remove: ["member@example.com"] },
        admin(),
      ),
    ).toMatchObject({ added: 1, removed: 1, members: 1 });
    expect(
      await refusal(
        "everyapp_workspace_group_members_set",
        { group: "Sales", users: [adminId], add: [memberId] },
        admin(),
      ),
    ).toBe("INVALID_INPUT: Give users (the full list) or add/remove, not both");
    expect(
      await refusal(
        "everyapp_workspace_group_members_set",
        { group: "Sales" },
        admin(),
      ),
    ).toBe("INVALID_INPUT: Give users (the full list), or add and/or remove");
    const members = await data(
      "everyapp_workspace_group_members",
      { group: "Sales" },
      admin(),
    );
    expect(
      (members["users"] as { id: string; inGroup: boolean }[])
        .filter((user) => user.inGroup)
        .map((user) => user.id),
    ).toEqual([adminId]);

    // Apps: by manifest id or row id.
    expect(
      await data(
        "everyapp_workspace_group_apps_set",
        { group: "Sales", add: ["crm"] },
        admin(),
      ),
    ).toMatchObject({ granted: 1, revoked: 0, apps: 1 });
    expect(
      (
        (
          await data(
            "everyapp_workspace_group_apps",
            { group: "Sales" },
            admin(),
          )
        )["apps"] as { id: string; granted: boolean }[]
      ).find((app) => app.id === crmRowId)?.granted,
    ).toBe(true);
    expect(
      await data(
        "everyapp_workspace_group_apps_set",
        { group: "Sales", apps: [] },
        admin(),
      ),
    ).toMatchObject({ granted: 0, revoked: 1, apps: 0 });
    expect(
      await refusal(
        "everyapp_workspace_group_apps_set",
        { group: "Sales", add: ["nope"] },
        admin(),
      ),
    ).toBe('APP_NOT_FOUND: No app "nope" here');

    expect(
      await data(
        "everyapp_workspace_group_set",
        { group: "Sales", name: "Sales team" },
        admin(),
      ),
    ).toMatchObject({
      group: {
        id: group.id,
        name: "Sales team",
        description: "The sales team",
      },
    });
    expect(
      (await data("everyapp_workspace_groups", {}, admin()))["groups"],
    ).toEqual([
      expect.objectContaining({
        id: group.id,
        name: "Sales team",
        memberCount: 1,
        appCount: 0,
      }),
    ]);
    expect(
      await data(
        "everyapp_workspace_group_delete",
        { group: group.id },
        admin(),
      ),
    ).toEqual({ deleted: { id: group.id, name: "Sales team" } });
    expect(
      await refusal(
        "everyapp_workspace_group_members",
        { group: "Sales team" },
        admin(),
      ),
    ).toBe('GROUP_NOT_FOUND: No group "Sales team" here');
  });

  it("lists apps, edits one, grants and revokes access, caps it, and the owner deletes it with confirm", async () => {
    const apps = (await data("everyapp_workspace_apps", {}, admin()))[
      "apps"
    ] as Record<string, unknown>[];
    expect(apps).toEqual([
      expect.objectContaining({
        id: crmRowId,
        appId: "crm",
        name: "CRM",
        everyone: false,
        // The deploy granted its first access (test/registry.ts).
        accessCount: expect.any(Number),
        readOnly: false,
        status: "active",
      }),
    ]);
    expect(apps[0]).not.toHaveProperty("manifest");
    expect(apps[0]).not.toHaveProperty("secretNames");

    expect(
      await data(
        "everyapp_workspace_app_set",
        { app: "crm", description: "Customers and deals", everyone: true },
        admin(),
      ),
    ).toMatchObject({
      app: { id: crmRowId, description: "Customers and deals", everyone: true },
    });
    // Everyone: every current member was granted.
    const access = await data(
      "everyapp_workspace_app_access",
      { app: crmRowId },
      admin(),
    );
    expect(
      (access["users"] as { hasAccess: boolean }[]).every(
        (user) => user.hasAccess,
      ),
    ).toBe(true);
    expect(
      await data(
        "everyapp_workspace_app_access_set",
        { app: "crm", remove: ["member@example.com"] },
        admin(),
      ),
    ).toMatchObject({ app: { appId: "crm" }, granted: 0, revoked: 1 });
    expect(
      await data(
        "everyapp_workspace_app_access_set",
        { app: "crm", users: [memberId] },
        owner(),
      ),
      // The acting owner keeps their own access: only the admin's is revoked.
    ).toMatchObject({ granted: 1, revoked: 1 });

    expect(
      await data(
        "everyapp_workspace_app_cap",
        { app: "crm", cap: 1000 },
        admin(),
      ),
    ).toEqual({
      app: { id: crmRowId, appId: "crm", name: "CRM" },
      monthlyCallCap: 1000,
      capUnlimited: false,
      effectiveMonthlyCallCap: 1000,
      capSource: "app",
    });
    const usage = await data("everyapp_workspace_usage", {}, admin());
    expect(usage).toMatchObject({
      month: new Date().toISOString().slice(0, 7),
      byApp: [
        expect.objectContaining({ appRowId: crmRowId, monthlyCallCap: 1000 }),
      ],
    });
    expect(
      await data(
        "everyapp_workspace_app_cap",
        { app: crmRowId, cap: null },
        admin(),
      ),
    ).toMatchObject({ monthlyCallCap: null });
    expect(
      await refusal("everyapp_workspace_usage", { month: "2026-13" }, admin()),
    ).toBe("INVALID_INPUT: month must be YYYY-MM");

    expect(
      await call(
        "everyapp_workspace_app_delete",
        { app: "crm", confirm: true },
        admin(),
      ),
    ).toMatchObject({ unknown: true });
    expect(
      await refusal("everyapp_workspace_app_delete", { app: "crm" }, owner()),
    ).toMatch(/^Invalid arguments for everyapp_workspace_app_delete: /);
    expect(
      await data(
        "everyapp_workspace_app_delete",
        { app: "crm", confirm: true },
        owner(),
      ),
    ).toMatchObject({ deleted: { id: crmRowId, appId: "crm" } });
    expect(
      (await data("everyapp_workspace_apps", {}, owner()))["apps"],
    ).toEqual([]);
  });

  it("sets the workspace default cap, caps an app under it, exempts it (unlimited), lets it inherit again, and usage shows the cap that binds each app and its source; a member sees neither cap tool, a read-only admin cannot set", async () => {
    const crm = { id: crmRowId, appId: "crm", name: "CRM" };
    // Nothing set: the app has no cap and nothing binds it.
    expect(await data("everyapp_workspace_usage", {}, admin())).toMatchObject({
      defaultMonthlyCallCap: null,
      byApp: [
        expect.objectContaining({
          appRowId: crmRowId,
          monthlyCallCap: null,
          capUnlimited: false,
          effectiveMonthlyCallCap: null,
          capSource: null,
          paused: false,
        }),
      ],
    });

    // The default binds every app without a row of its own.
    expect(
      await data("everyapp_workspace_cap_default", { cap: 1000 }, admin()),
    ).toEqual({ defaultMonthlyCallCap: 1000 });
    // Inherit: cap null alone keeps the app on the default.
    expect(
      await data(
        "everyapp_workspace_app_cap",
        { app: "crm", cap: null },
        admin(),
      ),
    ).toEqual({
      app: crm,
      monthlyCallCap: null,
      capUnlimited: false,
      effectiveMonthlyCallCap: 1000,
      capSource: "default",
    });
    // Set: the app's own cap wins over the default.
    expect(
      await data(
        "everyapp_workspace_app_cap",
        { app: "crm", cap: 500 },
        admin(),
      ),
    ).toEqual({
      app: crm,
      monthlyCallCap: 500,
      capUnlimited: false,
      effectiveMonthlyCallCap: 500,
      capSource: "app",
    });
    // Unlimited: no cap at all, whatever the default.
    expect(
      await data(
        "everyapp_workspace_app_cap",
        { app: crmRowId, cap: null, unlimited: true },
        admin(),
      ),
    ).toEqual({
      app: crm,
      monthlyCallCap: null,
      capUnlimited: true,
      effectiveMonthlyCallCap: null,
      capSource: null,
    });
    // A cap and unlimited together: the service refuses.
    expect(
      await refusal(
        "everyapp_workspace_app_cap",
        { app: "crm", cap: 10, unlimited: true },
        admin(),
      ),
    ).toBe("INVALID_INPUT: An app has a cap or no cap, not both.");
    // Usage carries the default and, per app, the effective cap and its source.
    expect(await data("everyapp_workspace_usage", {}, admin())).toMatchObject({
      defaultMonthlyCallCap: 1000,
      byApp: [
        expect.objectContaining({
          appRowId: crmRowId,
          monthlyCallCap: null,
          capUnlimited: true,
          effectiveMonthlyCallCap: null,
          capSource: null,
          paused: false,
        }),
      ],
    });
    // Inherit again: the default shows as what binds it.
    await data(
      "everyapp_workspace_app_cap",
      { app: "crm", cap: null, unlimited: false },
      admin(),
    );
    expect(
      (
        (await data("everyapp_workspace_usage", {}, admin()))[
          "byApp"
        ] as Record<string, unknown>[]
      )[0],
    ).toMatchObject({
      capUnlimited: false,
      effectiveMonthlyCallCap: 1000,
      capSource: "default",
    });
    // Clear the default: nothing binds the app again.
    expect(
      await data("everyapp_workspace_cap_default", { cap: null }, admin()),
    ).toEqual({ defaultMonthlyCallCap: null });
    expect(
      (
        (await data("everyapp_workspace_usage", {}, admin()))[
          "byApp"
        ] as Record<string, unknown>[]
      )[0],
    ).toMatchObject({ effectiveMonthlyCallCap: null, capSource: null });
    // Out of the schema's range: refused before the handler.
    expect(
      await refusal("everyapp_workspace_cap_default", { cap: 0 }, admin()),
    ).toMatch(/^Invalid arguments for everyapp_workspace_cap_default: /);

    // A member sees neither tool, and a read-only admin cannot set either.
    expect(await toolNames(member())).not.toContain(
      "everyapp_workspace_cap_default",
    );
    expect(
      await call("everyapp_workspace_cap_default", { cap: 10 }, member()),
    ).toEqual({
      ok: false,
      unknown: true,
      message: "Unknown tool: everyapp_workspace_cap_default",
    });
    const readOnly = admin({
      access: "read",
      credential: { kind: "oauth", id: "mcpc_ro", clientName: "Claude" },
    });
    expect(await toolNames(readOnly)).not.toContain(
      "everyapp_workspace_cap_default",
    );
    for (const [name, args] of [
      ["everyapp_workspace_cap_default", { cap: 10 }],
      ["everyapp_workspace_app_cap", { app: "crm", cap: 10 }],
    ] as const) {
      expect(await call(name, { ...args }, readOnly), name).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
    }
    expect(await data("everyapp_workspace_usage", {}, readOnly)).toMatchObject({
      defaultMonthlyCallCap: null,
    });
  });

  it("renames the workspace under the 64-character rule; the slug stays", async () => {
    expect(
      await data(
        "everyapp_workspace_rename",
        { name: "  Acme   Corp " },
        admin(),
      ),
    ).toEqual({
      organization: { id: organizationId, name: "Acme Corp", slug: "acme" },
    });
    const [row] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(row).toMatchObject({ name: "Acme Corp", slug: "acme" });
    expect(
      await refusal(
        "everyapp_workspace_rename",
        { name: "x".repeat(64) + "y" },
        admin(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_workspace_rename: /);
    expect(
      await refusal("everyapp_workspace_rename", { name: "a​b" }, admin()),
    ).toMatch(/^INVALID_ORGANIZATION_NAME: /);
  });

  it("refuses an invitation to an address that isn't one, and past the organization's pending limit, as Better Auth's path does", async () => {
    for (const email of ["abc", "alice at example.com"]) {
      expect(
        await refusal("everyapp_workspace_invite", { email }, admin()),
        email,
      ).toBe("INVALID_INPUT: email must be an email address");
    }
    expect(await db.select().from(invitations)).toEqual([]);
    // At the limit of pending, unexpired invitations the next is refused;
    // one that expired no longer counts.
    const rows = Array.from({ length: INVITATION_LIMIT }, (_, index) =>
      pendingInvitation(`inv-${index}`, `p${index}@example.com`),
    );
    for (let at = 0; at < rows.length; at += 25) {
      await db.insert(invitations).values(rows.slice(at, at + 25));
    }
    expect(
      await refusal(
        "everyapp_workspace_invite",
        { email: "one-more@example.com" },
        admin(),
      ),
    ).toMatch(/^INVITATION_LIMIT_REACHED: /);
    expect(await db.select().from(invitations)).toHaveLength(INVITATION_LIMIT);
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, "inv-0"));
    expect(
      await data(
        "everyapp_workspace_invite",
        { email: "one-more@example.com" },
        admin(),
      ),
    ).toMatchObject({ email: "one-more@example.com", role: "member" });
  });

  it("lists, counts and cancels an expired pending invitation, as Admin → Users does", async () => {
    await db.insert(invitations).values(
      pendingInvitation("inv_old", "old@example.com", {
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      }),
    );
    expect(
      (await data("everyapp_workspace_users", {}, admin()))["invitations"],
    ).toEqual([
      expect.objectContaining({ id: "inv_old", email: "old@example.com" }),
    ]);
    expect(
      (await data("everyapp_workspace_show", {}, admin()))["counts"],
    ).toMatchObject({ pendingInvitations: 1 });
    expect(
      await data(
        "everyapp_workspace_uninvite",
        { invitation: "inv_old" },
        admin(),
      ),
    ).toEqual({ canceled: { id: "inv_old", email: "old@example.com" } });
    expect((await db.select().from(invitations))[0]?.status).toBe("canceled");
    expect(
      (await data("everyapp_workspace_show", {}, admin()))["counts"],
    ).toMatchObject({ pendingInvitations: 0 });
  });

  it("refuses to mail a password reset where the Gateway sends no email, and where it does mails the member, never the caller", async () => {
    // No sender: refused before any reset token is minted.
    expect(
      await refusal(
        "everyapp_workspace_reset_email",
        { user: "member@example.com" },
        admin(),
      ),
    ).toMatch(/^EMAIL_NOT_CONFIGURED: /);
    expect(await db.select().from(verifications)).toEqual([]);
    expect((await activityRows())[0]).toMatchObject({
      tool: { name: "everyapp_workspace_reset_email" },
      outcome: "tool_error",
    });

    // A sender: the mail goes to the member with a one-hour token, and the
    // answer carries no link.
    const sent: { to: string; subject: string; text?: string }[] = [];
    hoisted.env["EMAIL_FROM"] = "Every App <noreply@example.com>";
    hoisted.env["EMAIL"] = {
      send: async (mail: { to: string; subject: string; text?: string }) => {
        sent.push(mail);
        return { messageId: `m-${sent.length}` };
      },
    };
    try {
      const answer = await data(
        "everyapp_workspace_reset_email",
        { user: memberId },
        admin(),
      );
      expect(answer).toEqual({
        user: { id: memberId, email: "member@example.com" },
        sent: true,
      });
      expect(sent).toEqual([
        expect.objectContaining({
          to: "member@example.com",
          subject: "Reset your Every App password",
        }),
      ]);
      expect(sent[0]?.text).toMatch(
        /https:\/\/gateway\.example\.com\/reset-password\?token=[A-Za-z0-9_-]+/,
      );
      const text = JSON.stringify(answer);
      expect(text).not.toContain("token");
      expect(text).not.toContain("http");
      const [verification] = await db.select().from(verifications);
      expect(verification).toMatchObject({ value: memberId });
      expect(
        verification!.expiresAt.getTime() - Date.now(),
      ).toBeLessThanOrEqual(60 * 60 * 1000);

      // A delivery that fails is a refusal, never a sent: true.
      hoisted.env["EMAIL"] = {
        send: async () => {
          throw new Error("provider down");
        },
      };
      expect(
        await refusal(
          "everyapp_workspace_reset_email",
          { user: memberId },
          admin(),
        ),
      ).toMatch(/^EMAIL_DELIVERY_FAILED: /);
    } finally {
      delete hoisted.env["EMAIL_FROM"];
      delete hoisted.env["EMAIL"];
    }
  });

  it("reaches a group named like an id by its name as well as by its id", async () => {
    const created = await data(
      "everyapp_workspace_group_create",
      { name: "grp_sales" },
      admin(),
    );
    const group = created["group"] as { id: string };
    for (const ref of ["grp_sales", group.id]) {
      expect(
        (
          await data(
            "everyapp_workspace_group_members",
            { group: ref },
            admin(),
          )
        )["group"],
        ref,
      ).toEqual({ id: group.id, name: "grp_sales" });
    }
  });

  it("bounds the activity cursor, and filters by a removed app's manifest id and by everyapp", async () => {
    // A time past the Date range is refused by the schema, before the query.
    for (const createdAt of [1e16, 8_640_000_000_000_001]) {
      expect(
        await refusal(
          "everyapp_workspace_activity",
          { before: { createdAt, id: "x" } },
          owner(),
        ),
        String(createdAt),
      ).toMatch(/^Invalid arguments for everyapp_workspace_activity: /);
    }
    await auditRow({
      callId: "call-crm",
      organizationId,
      userId: adminId,
      tool: "crm_list_deals",
      appId: "crm",
      appRowId: crmRowId,
    });
    const names = async (app: string) =>
      (
        (await data("everyapp_workspace_activity", { app }, owner()))[
          "calls"
        ] as { tool: { name: string } }[]
      ).map((row) => row.tool.name);
    expect(await names("crm")).toEqual(["crm_list_deals"]);
    // Removed, the app's rows are still its own, by manifest id or row id.
    await data(
      "everyapp_workspace_app_delete",
      { app: "crm", confirm: true },
      owner(),
    );
    expect(await names("crm")).toEqual(["crm_list_deals"]);
    expect(await names(crmRowId)).toEqual(["crm_list_deals"]);
    // The gateway's own tools, under everyapp: the calls above.
    const own = await names("everyapp");
    expect(own).toContain("everyapp_workspace_app_delete");
    expect(own).toContain("everyapp_workspace_activity");
    expect(own).not.toContain("crm_list_deals");
  });

  it("writes one mcp_tool_calls row per call that Admin → Activity lists, and reads them back as activity", async () => {
    await data("everyapp_workspace_show", {}, admin());
    await data(
      "everyapp_workspace_group_create",
      { name: "Ops" },
      admin({
        credential: { kind: "oauth", id: "mcpc_1", clientName: "Claude" },
      }),
    );
    // Through the wrappers too: one row, naming the tool with via.
    await data(
      "everyapp_call_write",
      {
        name: "everyapp_workspace_group_set",
        arguments: { group: "Ops", description: "Operations" },
      },
      admin(),
    );
    const rows = await activityRows();
    expect(rows.map((row) => [row.tool.name, row.tool.via])).toEqual([
      ["everyapp_workspace_group_set", "everyapp_call_write"],
      ["everyapp_workspace_group_create", null],
      ["everyapp_workspace_show", null],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        user: { id: adminId, email: "admin@example.com" },
        app: { slug: "everyapp", rowId: null, removed: false },
        decision: "allowed",
        outcome: "ok",
        resultBytes: expect.any(Number),
      });
    }
    expect(rows[1]!.credential).toMatchObject({
      kind: "oauth",
      clientName: "Claude",
    });
    expect(rows[0]!.tool.risk).toBe("write");
    expect(rows[2]!.tool.risk).toBe("read");

    // The activity tool reads the same rows, filtered, with the page cursor.
    const page = await data(
      "everyapp_workspace_activity",
      { user: "admin@example.com", limit: 2 },
      owner(),
    );
    expect(
      (page["calls"] as { tool: { name: string } }[]).map(
        (row) => row.tool.name,
      ),
    ).toEqual([
      "everyapp_workspace_group_set",
      "everyapp_workspace_group_create",
    ]);
    expect(page["nextBefore"]).toEqual({
      createdAt: expect.any(Number),
      id: expect.any(String),
    });
    const next = await data(
      "everyapp_workspace_activity",
      { user: adminId, limit: 2, before: page["nextBefore"] },
      owner(),
    );
    expect(
      (next["calls"] as { tool: { name: string } }[]).map(
        (row) => row.tool.name,
      ),
    ).toEqual(["everyapp_workspace_show"]);
    expect(
      (
        (
          await data(
            "everyapp_workspace_activity",
            { decision: "allowed", risk: "write" },
            owner(),
          )
        )["calls"] as unknown[]
      ).length,
    ).toBe(2);
    expect(
      await refusal(
        "everyapp_workspace_activity",
        { since: "yesterday" },
        owner(),
      ),
    ).toBe("INVALID_INPUT: since must be an ISO 8601 time");
    expect(WORKSPACE_ACTIVITY_PAGE_MAX).toBe(TOOL_CALL_PAGE_MAX);
  });
});

describe("a member's own tokens and connections", () => {
  it("lists their tokens without a value, revokes one by name, and never another member's", async () => {
    const mine = await UserPatService.create({
      userId: memberId,
      organizationId,
      name: "laptop",
      scopes: ["mcp:read"],
    });
    const theirs = await UserPatService.create({
      userId: adminId,
      organizationId,
      name: "laptop",
      scopes: ["mcp:read"],
    });
    const listed = await data("everyapp_my_tokens", {}, member());
    expect(listed["tokens"]).toEqual([
      expect.objectContaining({
        id: mine.row.id,
        name: "laptop",
        tokenPrefix: mine.row.tokenPrefix,
        scopes: ["mcp:read"],
        revokedAt: null,
      }),
    ]);
    const text = JSON.stringify(listed);
    expect(text).not.toContain(mine.plaintext);
    expect(text).not.toContain(theirs.row.id);
    expect(text).not.toMatch(/epat_[0-9a-f]{64}/);

    expect(
      await data("everyapp_revoke_token", { token: "laptop" }, member()),
    ).toEqual({
      token: { id: mine.row.id, name: "laptop" },
      alreadyRevoked: false,
    });
    expect(
      await data("everyapp_revoke_token", { token: mine.row.id }, member()),
    ).toMatchObject({ alreadyRevoked: true });
    expect(
      await refusal(
        "everyapp_revoke_token",
        { token: theirs.row.id },
        member(),
      ),
    ).toBe("TOKEN_NOT_FOUND: Token not found");
    // The admin's own token still works for them.
    expect(
      await data("everyapp_revoke_token", { token: theirs.row.id }, admin()),
    ).toMatchObject({ alreadyRevoked: false });
  });

  it("lists their AI connections and revokes one, saying when it is this very one", async () => {
    const now = new Date();
    for (const [id, userId] of [
      ["mcpc_mine", memberId],
      ["mcpc_theirs", adminId],
    ] as const) {
      await McpConnectionRepository.create({
        id,
        userId,
        organizationId,
        clientId: "https://claude.ai/client",
        clientName: "Claude",
        clientDomain: "claude.ai",
        redirectUri: "https://claude.ai/callback",
        redirectHost: "claude.ai",
        appScope: "all",
        appRowIds: [],
        access: "write",
        createdAt: now,
      });
    }
    const listed = await data("everyapp_my_connections", {}, member());
    expect(listed["connections"]).toEqual([
      expect.objectContaining({
        id: "mcpc_mine",
        organizationName: "acme",
        clientName: "Claude",
        apps: "all",
        access: "write",
      }),
    ]);
    expect(
      await refusal(
        "everyapp_revoke_connection",
        { connection: "mcpc_theirs" },
        member(),
      ),
    ).toBe("CONNECTION_NOT_FOUND: Connection not found");
    expect(
      await data(
        "everyapp_revoke_connection",
        { connection: "mcpc_mine" },
        callerFor(memberId, "member", {
          credential: { kind: "oauth", id: "mcpc_mine", clientName: "Claude" },
        }),
      ),
    ).toEqual({ revoked: "mcpc_mine", endsThisConnection: true });
    expect(
      (await data("everyapp_my_connections", {}, member()))["connections"],
    ).toEqual([]);
  });
});

describe("identifiers resolve inside the caller's organization alone", () => {
  it("answers not-found for another organization's user, app, group and invitation by every identifier, and shows none of its activity", async () => {
    const betaId = await seedOrganization(db, "beta");
    const betaOwnerId = await seedMember(db, {
      organizationId: betaId,
      role: "owner",
      email: "beta-owner@example.com",
    });
    const beta = { organizationId: betaId, userId: betaOwnerId };
    // Beta's own crm, under the same manifest id as Acme's, and one Acme lacks.
    const betaCrmRowId = await deploy("crm", "Beta CRM", beta);
    const betaBillingRowId = await deploy("billing", "Billing", beta);
    await GroupRepository.create({
      id: "grp_0123456789abcdef",
      organizationId: betaId,
      name: "Sales",
      description: null,
      createdBy: betaOwnerId,
    });
    await db.insert(invitations).values(
      pendingInvitation("inv_beta", "pending@beta.example.com", {
        organizationId: betaId,
        inviterId: betaOwnerId,
      }),
    );
    await auditRow({
      callId: "call-beta",
      organizationId: betaId,
      userId: betaOwnerId,
      tool: "crm_beta_only",
      appId: "crm",
      appRowId: betaCrmRowId,
    });
    const acme = owner();

    // A user, by email and by id.
    for (const user of ["beta-owner@example.com", betaOwnerId]) {
      expect(
        await refusal("everyapp_workspace_role", { user, role: "admin" }, acme),
        user,
      ).toMatch(/^USER_NOT_FOUND: /);
      expect(
        await refusal("everyapp_workspace_deactivate", { user }, acme),
        user,
      ).toMatch(/^USER_NOT_FOUND: /);
      expect(
        await refusal(
          "everyapp_workspace_app_access_set",
          { app: "crm", add: [user] },
          acme,
        ),
        user,
      ).toMatch(/^USER_NOT_FOUND: /);
    }
    // An app: `crm` names Acme's row; Beta's row ids and its own manifest
    // id are nobody's here.
    expect(
      (await data("everyapp_workspace_app_access", { app: "crm" }, acme))[
        "app"
      ],
    ).toMatchObject({ id: crmRowId, appId: "crm" });
    for (const app of [betaCrmRowId, betaBillingRowId, "billing"]) {
      expect(
        await refusal("everyapp_workspace_app_set", { app, name: "X" }, acme),
        app,
      ).toMatch(/^APP_NOT_FOUND: /);
      expect(
        await refusal("everyapp_workspace_app_cap", { app, cap: 10 }, acme),
        app,
      ).toMatch(/^APP_NOT_FOUND: /);
      expect(
        await refusal(
          "everyapp_workspace_app_delete",
          { app, confirm: true },
          acme,
        ),
        app,
      ).toMatch(/^APP_NOT_FOUND: /);
    }
    // A group, by name and by id; the name is free for Acme's own.
    for (const group of ["Sales", "grp_0123456789abcdef"]) {
      expect(
        await refusal("everyapp_workspace_group_members", { group }, acme),
        group,
      ).toMatch(/^GROUP_NOT_FOUND: /);
      expect(
        await refusal("everyapp_workspace_group_delete", { group }, acme),
        group,
      ).toMatch(/^GROUP_NOT_FOUND: /);
    }
    expect(
      await data("everyapp_workspace_group_create", { name: "Sales" }, acme),
    ).toMatchObject({ group: { name: "Sales" } });
    expect(
      await refusal(
        "everyapp_workspace_group_apps_set",
        { group: "Sales", add: [betaCrmRowId] },
        acme,
      ),
    ).toMatch(/^APP_NOT_FOUND: /);
    // An invitation, by id and by email.
    for (const invitation of ["inv_beta", "pending@beta.example.com"]) {
      expect(
        await refusal("everyapp_workspace_uninvite", { invitation }, acme),
        invitation,
      ).toMatch(/^INVITATION_NOT_FOUND: /);
    }
    expect(
      (
        await db
          .select()
          .from(invitations)
          .where(eq(invitations.id, "inv_beta"))
      )[0]?.status,
    ).toBe("pending");
    // Activity: Beta's rows never show, filtered by its app or person or not.
    const names = async (args: Record<string, unknown>) =>
      (
        (await data("everyapp_workspace_activity", args, acme))["calls"] as {
          tool: { name: string };
        }[]
      ).map((row) => row.tool.name);
    expect(await names({ app: betaCrmRowId })).toEqual([]);
    expect(await names({ user: betaOwnerId })).toEqual([]);
    expect(await names({})).not.toContain("crm_beta_only");
    // Nor do the lists hold Beta's app or invitation.
    expect(
      (
        (await data("everyapp_workspace_apps", {}, acme))["apps"] as {
          id: string;
        }[]
      ).map((app) => app.id),
    ).toEqual([crmRowId]);
    expect(
      (await data("everyapp_workspace_users", {}, acme))["invitations"],
    ).toEqual([]);
  });
});

describe("the events tools over /mcp", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sendMock = vi.fn<EventMailer["send"]>();
  const deliveryDeps: DeliveryDeps = {
    fetch: (input, init) => fetchMock(input, init),
    mailer: async () => ({
      isConfigured: () => true,
      send: (options) => sendMock(options),
      recipientHash: async (address) => `h(${address})`,
    }),
    now: () => new Date(),
    gatewayUrl: () => GATEWAY,
    userAgent: () => "every-app-gateway/test",
    targetRules: () => ({
      allowPrivate: false,
      gatewayHosts: ["gateway.example.com"],
    }),
  };
  const HOOK = "https://hooks.example.net/every-app";

  beforeEach(() => {
    fetchMock
      .mockReset()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    sendMock.mockReset().mockResolvedValue({ status: "delivered" });
    setDeliveryDepsForTests(deliveryDeps);
    clearEventSubjectCachesForTests();
  });

  afterEach(() => {
    setDeliveryDepsForTests(undefined);
  });

  /** A webhook subscription added over /mcp by the admin; its answer. */
  async function addHook(args: Record<string, unknown> = {}) {
    return data(
      "everyapp_workspace_events_add",
      { url: HOOK, ...args },
      admin(),
    );
  }

  const idOf = (answer: Record<string, unknown>) =>
    (answer["subscription"] as { id: string }).id;

  it("adds a webhook and returns the generated secret once: the list never carries it, nor a URL's query, and the row records the agent", async () => {
    const added = await addHook({
      url: `${HOOK}?token=receiver-own-token`,
      name: "Slack #ops",
      events: ["member.*", "cap.reached"],
    });
    const secret = added["secret"] as string;
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(added["next"]).toContain("opens nothing on the Gateway");
    expect(added["subscription"]).toMatchObject({
      id: expect.stringMatching(/^sub_[0-9a-f]{24}$/),
      name: "Slack #ops",
      sink: "webhook",
      target: "hooks.example.net/every-app",
      events: ["member.*", "cap.reached"],
      enabled: true,
      builtin: null,
      lastDeliveryAt: null,
      consecutiveFailures: 0,
    });
    const id = idOf(added);
    // The row signs with it, and says an agent made it, by credential id.
    const [row] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, id));
    expect(row).toMatchObject({ secret, createdBy: "agent:pat_admin" });

    // No list, page or later answer shows it again.
    const listed = await call("everyapp_workspace_events", {}, admin());
    if (!listed.ok) throw new Error("the list was refused");
    expect(listed.data["subscriptions"]).toEqual([
      expect.objectContaining({ id, target: "hooks.example.net/every-app" }),
    ]);
    expect(
      (listed.data["subscriptions"] as Record<string, unknown>[])[0],
    ).not.toHaveProperty("secret");
    for (const text of [listed.text, JSON.stringify(listed.data)]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain("receiver-own-token");
    }
    const changed = await data(
      "everyapp_workspace_events_set",
      { subscription: id, name: "Slack #alerts" },
      admin(),
    );
    const tested = await data(
      "everyapp_workspace_events_test",
      { subscription: id },
      admin(),
    );
    const deliveries = await data(
      "everyapp_workspace_event_deliveries",
      {},
      admin(),
    );
    for (const answer of [changed, tested, deliveries]) {
      expect(JSON.stringify(answer)).not.toContain(secret);
    }

    // A secret the caller gave is never returned at all.
    const given = await addHook({ secret: "the-receivers-own-secret" });
    expect(given).not.toHaveProperty("secret");
    expect(JSON.stringify(given)).not.toContain("the-receivers-own-secret");
  });

  it("adds an email subscription for owners, or owners and admins, with no secret, and says when the Gateway sends no email", async () => {
    const added = await data(
      "everyapp_workspace_events_add",
      { email: "owners", events: ["cap.*"] },
      admin(),
    );
    expect(added).not.toHaveProperty("secret");
    expect(added["subscription"]).toMatchObject({
      name: "Email owners and admins",
      sink: "email",
      target: "email to the owners",
      recipients: "owners",
      events: ["cap.*"],
    });
    expect(added["next"]).toContain("EMAIL_FROM");
  });

  it("refuses what the service refuses: url and email together, neither, a target the rules refuse, a pattern that matches nothing, the 26th", async () => {
    expect(
      await refusal(
        "everyapp_workspace_events_add",
        { url: HOOK, email: "admins" },
        admin(),
      ),
    ).toMatch(/^EVENT_SINK_CONFLICT: /);
    expect(await refusal("everyapp_workspace_events_add", {}, admin())).toMatch(
      /^INVALID_INPUT: /,
    );
    for (const url of [
      "http://hooks.example.net/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "https://gateway.example.com/api",
    ]) {
      expect(
        await refusal("everyapp_workspace_events_add", { url }, admin()),
        url,
      ).toMatch(/^EVENT_TARGET_REFUSED: /);
    }
    expect(
      await refusal(
        "everyapp_workspace_events_add",
        { url: HOOK, events: ["member.nope"] },
        admin(),
      ),
    ).toMatch(/^EVENT_TYPE_UNKNOWN: /);
    for (let index = 0; index < 25; index += 1) {
      await EventSubscriptionService.add(
        { orgId: organizationId, userId: adminId, role: "admin" },
        { url: `https://hooks${index}.example.net/` },
      );
    }
    expect(await refusal("everyapp_workspace_events_add", {}, admin())).toMatch(
      /^INVALID_INPUT: /,
    );
    expect(
      await refusal("everyapp_workspace_events_add", { url: HOOK }, admin()),
    ).toMatch(/^EVENT_SUBSCRIPTIONS_LIMIT: /);
    expect(await db.select().from(eventSubscriptions)).toHaveLength(25);
  });

  it("changes a subscription by id or by name: pauses it, replaces its events, renames it; a name two share and a call that changes nothing are refused", async () => {
    const id = idOf(await addHook({ name: "Slack #ops" }));
    expect(
      await data(
        "everyapp_workspace_events_set",
        { subscription: "slack #OPS", enabled: false },
        admin(),
      ),
    ).toMatchObject({ subscription: { id, enabled: false } });
    expect(
      await data(
        "everyapp_workspace_events_set",
        { subscription: id, events: ["app.crm.*"], name: "CRM feed" },
        admin(),
      ),
    ).toMatchObject({
      subscription: { id, name: "CRM feed", events: ["app.crm.*"] },
    });
    // An empty list is every event, as add's default.
    expect(
      await data(
        "everyapp_workspace_events_set",
        { subscription: "CRM feed", events: [], enabled: true },
        admin(),
      ),
    ).toMatchObject({ subscription: { id, events: ["*"], enabled: true } });
    expect(
      await refusal(
        "everyapp_workspace_events_set",
        { subscription: "CRM feed" },
        admin(),
      ),
    ).toMatch(/^INVALID_INPUT: Give enabled, events or name/);
    await addHook({ url: "https://b.example.net/", name: "CRM feed" });
    expect(
      await refusal(
        "everyapp_workspace_events_set",
        { subscription: "CRM feed", enabled: false },
        admin(),
      ),
    ).toBe('INVALID_INPUT: 2 subscriptions are named "CRM feed"; give the id');
    expect(
      await refusal(
        "everyapp_workspace_events_set",
        { subscription: "sub_000000000000000000000000", enabled: false },
        admin(),
      ),
    ).toMatch(/^EVENT_SUBSCRIPTION_NOT_FOUND: /);
  });

  it("removes a subscription only with confirm, and turns the built-in Cap alerts off instead, saying so", async () => {
    const id = idOf(await addHook({ name: "Zapier" }));
    expect(
      await refusal(
        "everyapp_workspace_events_remove",
        { subscription: id },
        admin(),
      ),
    ).toMatch(/^Invalid arguments for everyapp_workspace_events_remove: /);
    expect(
      await data(
        "everyapp_workspace_events_remove",
        { subscription: "Zapier", confirm: true },
        admin(),
      ),
    ).toEqual({
      subscription: { id, name: "Zapier" },
      removed: true,
      disabled: false,
    });
    expect(
      await db
        .select()
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.id, id)),
    ).toEqual([]);

    // The first cap makes the built-in email subscription.
    await data(
      "everyapp_workspace_app_cap",
      { app: "crm", cap: 1000 },
      admin(),
    );
    const [capAlerts] = (
      (await data("everyapp_workspace_events", {}, admin()))[
        "subscriptions"
      ] as { id: string; name: string; builtin: string | null }[]
    ).filter((row) => row.builtin === "cap_alerts");
    expect(capAlerts).toMatchObject({ name: "Cap alerts" });
    const removed = await data(
      "everyapp_workspace_events_remove",
      { subscription: "Cap alerts", confirm: true },
      admin(),
    );
    expect(removed).toMatchObject({
      subscription: { id: capAlerts!.id, name: "Cap alerts" },
      removed: false,
      disabled: true,
      note: expect.stringContaining("turned off instead of removed"),
    });
    const [row] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, capAlerts!.id));
    expect(row).toMatchObject({ enabled: false, builtin: "cap_alerts" });
  });

  it("sends a test ping to that subscription only, a paused one too, and answers the first attempt with its status or its error", async () => {
    const tested = idOf(await addHook({ name: "Tested" }));
    const other = idOf(await addHook({ url: "https://b.example.net/" }));
    await data(
      "everyapp_workspace_events_set",
      { subscription: tested, enabled: false },
      admin(),
    );
    const answer = await data(
      "everyapp_workspace_events_test",
      { subscription: "Tested" },
      admin(),
    );
    expect(answer).toMatchObject({
      subscription: { id: tested, name: "Tested", enabled: false },
      delivered: true,
      delivery: {
        id: expect.stringMatching(/^dlv_[0-9a-f]{24}$/),
        event: { type: "ping", summary: "Test event from Every App" },
        subscription: { id: tested, name: "Tested" },
        state: "delivered",
        attempts: 1,
        statusCode: 200,
        error: null,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(HOOK);
    const rows = await db.select().from(eventDeliveries);
    expect(rows.map((row) => row.subscriptionId)).toEqual([tested]);
    expect(rows.some((row) => row.subscriptionId === other)).toBe(false);

    // A receiver that fails: the error, the status and the retry.
    fetchMock.mockResolvedValue(new Response("boom", { status: 500 }));
    const failed = await data(
      "everyapp_workspace_events_test",
      { subscription: other },
      admin(),
    );
    expect(failed).toMatchObject({
      delivered: false,
      delivery: {
        state: "failed",
        attempts: 1,
        statusCode: 500,
        error: expect.stringMatching(/^status_500/),
        nextAttemptAt: expect.any(String),
      },
    });

    // An email subscription says how many it mailed: the owner and the admin.
    const email = idOf(
      await data("everyapp_workspace_events_add", { email: "admins" }, admin()),
    );
    expect(
      await data(
        "everyapp_workspace_events_test",
        { subscription: email },
        admin(),
      ),
    ).toMatchObject({
      delivered: true,
      delivery: { state: "delivered", mailed: 2 },
    });
    expect(sendMock.mock.calls.map(([options]) => options.to).sort()).toEqual([
      "admin@example.com",
      "owner@example.com",
    ]);
  });

  it("lists deliveries newest first, one subscription's or the dead ones, pages with nextBefore, and redelivers a dead one; a delivered one is left alone", async () => {
    const hook = idOf(await addHook({ name: "Hook" }));
    const other = idOf(await addHook({ url: "https://b.example.net/" }));
    // A 410 is dead at once.
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 410 }));
    const dead = (
      await data(
        "everyapp_workspace_events_test",
        { subscription: hook },
        admin(),
      )
    )["delivery"] as { id: string; state: string };
    expect(dead.state).toBe("dead");
    await data(
      "everyapp_workspace_events_test",
      { subscription: hook },
      admin(),
    );
    await data(
      "everyapp_workspace_events_test",
      { subscription: other },
      admin(),
    );

    const all = await data("everyapp_workspace_event_deliveries", {}, admin());
    expect(all["deliveries"]).toHaveLength(3);
    expect(all["nextBefore"]).toBeNull();
    const ofHook = await data(
      "everyapp_workspace_event_deliveries",
      { subscription: "Hook" },
      admin(),
    );
    expect(
      (ofHook["deliveries"] as { subscription: { id: string } }[]).map(
        (delivery) => delivery.subscription.id,
      ),
    ).toEqual([hook, hook]);
    const deadOnly = await data(
      "everyapp_workspace_event_deliveries",
      { dead: true },
      admin(),
    );
    expect(deadOnly["deliveries"]).toEqual([
      expect.objectContaining({
        id: dead.id,
        state: "dead",
        statusCode: 410,
        event: expect.objectContaining({ type: "ping" }),
      }),
    ]);
    expect(JSON.stringify(deadOnly)).not.toContain('"data"');

    // Pages of two: the second continues where the first stopped.
    const first = await data(
      "everyapp_workspace_event_deliveries",
      { limit: 2 },
      admin(),
    );
    expect(first["deliveries"]).toHaveLength(2);
    expect(first["nextBefore"]).toEqual(expect.stringMatching(/^\d+:dlv_/));
    const second = await data(
      "everyapp_workspace_event_deliveries",
      { limit: 2, before: first["nextBefore"] },
      admin(),
    );
    const ids = [
      ...(first["deliveries"] as { id: string }[]),
      ...(second["deliveries"] as { id: string }[]),
    ].map((delivery) => delivery.id);
    expect(new Set(ids).size).toBe(3);
    expect(
      await refusal(
        "everyapp_workspace_event_deliveries",
        { before: "yesterday" },
        admin(),
      ),
    ).toBe("INVALID_INPUT: before must be the previous answer's nextBefore");

    // Redeliver the dead one: it goes again, the schedule starting over.
    const redelivered = await data(
      "everyapp_workspace_event_redeliver",
      { delivery: dead.id },
      admin(),
    );
    expect(redelivered).toMatchObject({
      redelivered: true,
      delivery: {
        id: dead.id,
        state: "delivered",
        attempts: 1,
        statusCode: 200,
        redeliveredAt: expect.any(String),
      },
    });
    const fetches = fetchMock.mock.calls.length;
    expect(
      await data(
        "everyapp_workspace_event_redeliver",
        { delivery: dead.id },
        admin(),
      ),
    ).toMatchObject({
      redelivered: false,
      delivery: { id: dead.id, state: "delivered" },
      note: "It was delivered already, so nothing was sent again.",
    });
    expect(fetchMock.mock.calls.length).toBe(fetches);
    expect(
      await refusal(
        "everyapp_workspace_event_redeliver",
        { delivery: "dlv_000000000000000000000000" },
        admin(),
      ),
    ).toMatch(/^EVENT_DELIVERY_NOT_FOUND: /);
    expect(WORKSPACE_EVENT_DELIVERIES_PAGE_MAX).toBe(DELIVERIES_PAGE_MAX);
  });

  it("keeps every events tool inside the caller's organization: another's subscription and delivery are not found by id or name, and its deliveries are not listed", async () => {
    const betaId = await seedOrganization(db, "beta");
    const betaOwnerId = await seedMember(db, {
      organizationId: betaId,
      role: "owner",
      email: "beta-owner@example.com",
    });
    const beta = { orgId: betaId, userId: betaOwnerId, role: "owner" as const };
    const { subscription } = await EventSubscriptionService.add(beta, {
      url: "https://beta.example.net/hook",
      name: "Beta hook",
    });
    fetchMock.mockResolvedValueOnce(new Response("gone", { status: 410 }));
    const { delivery } = await EventSubscriptionService.test(
      beta,
      subscription.id,
    );
    expect(delivery).toMatchObject({ status: "dead" });
    fetchMock.mockClear();

    for (const ref of [subscription.id, "Beta hook"]) {
      expect(
        await refusal(
          "everyapp_workspace_events_set",
          { subscription: ref, enabled: false },
          owner(),
        ),
        ref,
      ).toMatch(/^EVENT_SUBSCRIPTION_NOT_FOUND: /);
      expect(
        await refusal(
          "everyapp_workspace_events_test",
          { subscription: ref },
          owner(),
        ),
        ref,
      ).toMatch(/^EVENT_SUBSCRIPTION_NOT_FOUND: /);
      expect(
        await refusal(
          "everyapp_workspace_events_remove",
          { subscription: ref, confirm: true },
          owner(),
        ),
        ref,
      ).toMatch(/^EVENT_SUBSCRIPTION_NOT_FOUND: /);
      expect(
        await refusal(
          "everyapp_workspace_event_deliveries",
          { subscription: ref },
          owner(),
        ),
        ref,
      ).toMatch(/^EVENT_SUBSCRIPTION_NOT_FOUND: /);
    }
    expect(
      await refusal(
        "everyapp_workspace_event_redeliver",
        { delivery: delivery!.id },
        owner(),
      ),
    ).toMatch(/^EVENT_DELIVERY_NOT_FOUND: /);
    expect(await data("everyapp_workspace_events", {}, owner())).toEqual({
      subscriptions: [],
    });
    expect(
      await data("everyapp_workspace_event_deliveries", {}, owner()),
    ).toEqual({ deliveries: [], nextBefore: null });
    // Beta's row and its dead delivery are as they were; nothing was sent.
    const [row] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, subscription.id));
    expect(row).toMatchObject({ enabled: true, organizationId: betaId });
    const [betaDelivery] = await db
      .select()
      .from(eventDeliveries)
      .where(eq(eventDeliveries.id, delivery!.id));
    expect(betaDelivery).toMatchObject({ status: "dead", attempts: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives a member nothing, and a read-only admin the two reads alone: the writes are unknown and nothing is written", async () => {
    // member.* only: each blocked call below is a tool.blocked event, which
    // a subscription to everything would be sent.
    const id = idOf(await addHook({ name: "Hook", events: ["member.*"] }));
    const writes: [string, Record<string, unknown>][] = [
      ["everyapp_workspace_events_add", { url: "https://c.example.net/" }],
      ["everyapp_workspace_events_set", { subscription: id, enabled: false }],
      ["everyapp_workspace_events_remove", { subscription: id, confirm: true }],
      ["everyapp_workspace_events_test", { subscription: id }],
      ["everyapp_workspace_event_redeliver", { delivery: "dlv_x" }],
    ];
    const reads: [string, Record<string, unknown>][] = [
      ["everyapp_workspace_events", {}],
      ["everyapp_workspace_event_deliveries", {}],
    ];
    for (const [name, args] of [...reads, ...writes]) {
      expect(await call(name, args, member()), name).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
      expect((await activityRows())[0], name).toMatchObject({
        tool: { name },
        decision: "blocked",
        reason: "role_required",
      });
    }
    const readOnly = admin({
      access: "read",
      credential: { kind: "oauth", id: "mcpc_ro", clientName: "Claude" },
    });
    expect(
      (await toolNames(readOnly)).filter((name) => name.includes("event")),
    ).toEqual([
      "everyapp_workspace_events",
      "everyapp_workspace_event_deliveries",
    ]);
    for (const [name, args] of reads) {
      expect((await call(name, args, readOnly)).ok, name).toBe(true);
    }
    for (const [name, args] of writes) {
      expect(await call(name, args, readOnly), name).toEqual({
        ok: false,
        unknown: true,
        message: `Unknown tool: ${name}`,
      });
      expect((await activityRows())[0], name).toMatchObject({
        tool: { name },
        decision: "blocked",
        reason: "read_only_connection",
      });
    }
    expect(await db.select().from(eventSubscriptions)).toEqual([
      expect.objectContaining({ id, enabled: true }),
    ]);
    expect(await db.select().from(eventDeliveries)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("writes one audit row per events call under app everyapp, holding neither the secret nor the URL", async () => {
    const added = await addHook({ name: "Audited" });
    await data(
      "everyapp_workspace_events_test",
      { subscription: "Audited" },
      admin(),
    );
    await data("everyapp_workspace_events", {}, admin());
    const rows = await activityRows();
    expect(rows.map((row) => [row.tool.name, row.tool.risk])).toEqual([
      ["everyapp_workspace_events", "read"],
      ["everyapp_workspace_events_test", "write"],
      ["everyapp_workspace_events_add", "write"],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({
        user: { id: adminId },
        app: { slug: "everyapp", rowId: null },
        decision: "allowed",
        outcome: "ok",
      });
    }
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(added["secret"] as string);
    expect(stored).not.toContain("hooks.example.net");
  });
});
