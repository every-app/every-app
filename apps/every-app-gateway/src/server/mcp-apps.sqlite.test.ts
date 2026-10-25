/**
 * MCP apps from Admin → Apps against a migrated SQLite database
 * (services/McpAppService.ts, the server functions' service): an owner or
 * admin adds a remote MCP server by URL and the rules' row and grants are
 * written, a server with no credential has its tools listed in the same
 * request, a member is refused, a refused URL or a taken credential name
 * comes back with the rule's sentence; an update bumps the block's
 * revision; on and off keep everything; remove is the owners' and is the
 * tombstone; Refresh tools lists again and says what changed; getMcpApp
 * shows the credential's state and every tool's risk with its source.
 *
 * The listing itself (catalog-sync's syncAppTools, which reaches the
 * remote server through the gateway's proxy) stands in here: it writes the
 * snapshot and remote_mcp_tools as the proxy does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

type ListedTool = {
  upstreamName: string;
  localName: string | null;
  riskHint: "read" | "write" | "destructive" | "unknown";
  /** The effective risk the snapshot serves it at. */
  risk?: "read" | "write" | "destructive";
  listed?: boolean;
  problem?: string | null;
  title?: string | null;
};

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
  background: [] as Promise<unknown>[],
  /** What the stand-in server lists, or an error to throw. */
  listing: [] as ListedTool[] | Error,
  syncs: [] as string[],
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: (task: Promise<unknown>) => {
    hoisted.background.push(task);
  },
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { db: testDbProxy(hoisted.testDb) };
});
vi.mock("@/server/toolbus/catalog-sync", () => ({
  logToolSync: () => undefined,
  // The listing as the proxy writes it: the snapshot from the block's
  // revision, and what the server listed tool by tool.
  syncAppTools: async (app: { rowId: string; organizationId: string }) => {
    hoisted.syncs.push(app.rowId);
    if (hoisted.listing instanceof Error) throw hoisted.listing;
    const { db } = await import("@/db");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { AppToolRepository } = await import(
      "@/server/repositories/AppToolRepository"
    );
    const [row] = await db
      .select({ manifest: schema.apps.manifest })
      .from(schema.apps)
      .where(eq(schema.apps.id, app.rowId));
    const rev =
      (JSON.parse(row?.manifest ?? "{}") as { remote?: { rev?: number } })
        .remote?.rev ?? 1;
    const listed = hoisted.listing.filter(
      (tool) => tool.listed !== false && tool.localName,
    );
    await AppToolRepository.replace({
      appRowId: app.rowId,
      organizationId: app.organizationId,
      versionId: `remote:${rev}`,
      status: listed.length ? "ok" : "empty",
      catalogHash: "hash",
      instructions: null,
      sdkVersion: null,
      warnings: [],
      lastError: null,
      tools: listed.map((tool) => ({
        name: tool.localName!,
        ...(tool.title ? { title: tool.title } : {}),
        description: `${tool.upstreamName} upstream`,
        risk: tool.risk ?? "write",
        inputSchema: { type: "object" },
      })),
    });
    await db
      .delete(schema.remoteMcpTools)
      .where(eq(schema.remoteMcpTools.appRowId, app.rowId));
    for (const tool of hoisted.listing) {
      await db.insert(schema.remoteMcpTools).values({
        appRowId: app.rowId,
        organizationId: app.organizationId,
        upstreamName: tool.upstreamName,
        localName: tool.localName,
        title: tool.title ?? null,
        riskHint: tool.riskHint,
        listed: tool.listed !== false && tool.localName !== null,
        problem: tool.problem ?? null,
        listedAt: new Date(),
      });
    }
    return {
      status: listed.length ? "ok" : "empty",
      toolCount: listed.length,
      catalogHash: "hash",
      sdkVersion: null,
      warnings: [],
    };
  },
}));

import { eq } from "drizzle-orm";
import { planProviderAppOn } from "@every-app/perimeter/registry";
import {
  apps,
  appToolCatalogs,
  appTools,
  remoteMcpCredentials,
  remoteMcpTools,
  userAppAccess,
} from "@/db/schema";
import { McpAppService } from "@/server/services/McpAppService";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";

type Role = "owner" | "admin" | "member";

const GATEWAY = "https://gateway.example.com";
const TREG = "https://treg.to/mcp/";

let db: TestDb;
let acme: string;
let owner: string;
let admin: string;
let member: string;

const as = (userId: string, role: Role, orgId = acme) => ({
  orgId,
  userId,
  role,
});

async function settle(): Promise<void> {
  while (hoisted.background.length) {
    await Promise.all(hoisted.background.splice(0));
  }
}

async function row(rowId: string) {
  const [found] = await db.select().from(apps).where(eq(apps.id, rowId));
  return found!;
}

async function grantees(rowId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: userAppAccess.userId })
    .from(userAppAccess)
    .where(eq(userAppAccess.appRowId, rowId));
  return rows.map((grant) => grant.userId).sort();
}

function manifestOf(stored: { manifest: string | null }) {
  return JSON.parse(stored.manifest ?? "{}") as {
    id: string;
    name: string;
    description: string;
    remote: {
      url: string;
      auth: Record<string, unknown>;
      risk: string;
      tools: Record<string, unknown>;
      rev: number;
    };
  };
}

/** The row `everyapp mcp on dataforseo` writes, with its grants. */
async function turnOnDataForSeo(): Promise<string> {
  const plan = planProviderAppOn({
    organizationId: acme,
    id: "dataforseo",
    existingApp: null,
    members: [
      { id: owner, role: "owner" },
      { id: admin, role: "admin" },
    ],
    actorUserId: owner,
    actor: "ben@example.com",
    now: Date.now(),
  });
  await db.insert(apps).values({
    ...plan.app,
    deployedAt: new Date(plan.app.deployedAt ?? Date.now()),
  });
  for (const grant of plan.grants) {
    await db.insert(userAppAccess).values(grant);
  }
  return plan.app.id;
}

const TREG_TOOLS: ListedTool[] = [
  {
    upstreamName: "getUser",
    localName: "get_user",
    riskHint: "read",
    risk: "read",
    title: "Get a user",
  },
  {
    upstreamName: "create_note",
    localName: "create_note",
    riskHint: "unknown",
  },
  {
    upstreamName: "delete_everything",
    localName: "delete_everything",
    riskHint: "destructive",
    risk: "destructive",
  },
  {
    upstreamName: "get-user",
    localName: null,
    riskHint: "read",
    listed: false,
    problem: 'skipped: two tools normalize to "get_user"',
  },
];

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  Object.assign(hoisted.env, {
    GATEWAY_URL: GATEWAY,
    APP_BASE_DOMAIN: "apps.example.com",
  });
  hoisted.background.length = 0;
  hoisted.listing = TREG_TOOLS;
  hoisted.syncs = [];
  db = await createTestDb();
  hoisted.testDb.current = db;
  acme = await seedOrganization(db, "acme");
  owner = await seedMember(db, { organizationId: acme, role: "owner" });
  admin = await seedMember(db, { organizationId: acme, role: "admin" });
  member = await seedMember(db, { organizationId: acme, role: "member" });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  // A listing that ran past its budget finishes after the response.
  await settle();
  vi.restoreAllMocks();
});

describe("adding a remote MCP server", () => {
  it("lets an admin add a server with no credential: the rules' row, access for them and the owners, and its tools listed in the request", async () => {
    const added = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      "admin@example.com",
    );
    expect(added).toEqual({
      rowId: expect.any(String),
      appId: "treg",
      name: "treg",
      kind: "new",
      authKind: "none",
      secret: null,
      setupCommand: null,
      toolCount: 3,
      toolsStatus: "ok",
    });
    expect(hoisted.syncs).toEqual([added.rowId]);

    const stored = await row(added.rowId);
    expect(stored).toMatchObject({
      organizationId: acme,
      appSlug: "treg",
      tier: "provider",
      status: "active",
      hostname: null,
      workerName: null,
      deployedByActor: "admin@example.com",
    });
    expect(manifestOf(stored).remote).toEqual({
      url: TREG,
      auth: { kind: "none" },
      risk: "annotations",
      tools: {},
      rev: 1,
    });
    // The person adding it, the owners and the admins; not the members.
    expect(await grantees(added.rowId)).toEqual([owner, admin].sort());
  });

  it("answers the command that sets a credentialed server's credential, and lists nothing until it is set", async () => {
    const added = await McpAppService.add(
      as(owner, "owner"),
      {
        url: TREG,
        name: "Treg",
        auth: { kind: "bearer" },
        risk: "write",
      },
      null,
    );
    expect(added).toMatchObject({
      appId: "treg",
      name: "Treg",
      authKind: "bearer",
      secret: "TREG_MCP_TOKEN",
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      toolCount: null,
      toolsStatus: null,
    });
    expect(hoisted.syncs).toEqual([]);
    expect(manifestOf(await row(added.rowId)).remote).toMatchObject({
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      risk: "write",
    });

    // Already set on the Gateway: nothing to run.
    hoisted.env["DOCS_MCP_TOKEN"] = "set";
    const docs = await McpAppService.add(
      as(owner, "owner"),
      {
        url: "https://docs.example.org/mcp",
        id: "docs",
        auth: { kind: "header", header: "X-Api-Key", secret: "DOCS_MCP_TOKEN" },
      },
      null,
    );
    expect(docs).toMatchObject({
      secret: "DOCS_MCP_TOKEN",
      setupCommand: null,
    });
    expect(manifestOf(await row(docs.rowId)).remote.auth).toEqual({
      kind: "header",
      header: "X-Api-Key",
      secret: "DOCS_MCP_TOKEN",
    });
  });

  it("refuses a member, and writes nothing", async () => {
    await expect(
      McpAppService.add(
        as(member, "member"),
        { url: TREG, auth: { kind: "none" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await db.select().from(apps)).toEqual([]);
  });

  it("refuses a URL the rules refuse, with the rule's own sentence", async () => {
    const add = (url: string) =>
      McpAppService.add(
        as(admin, "admin"),
        { url, auth: { kind: "none" } },
        null,
      );
    await expect(add("http://treg.to/mcp")).rejects.toMatchObject({
      name: "PublicError",
      code: "REMOTE_MCP_URL_REFUSED",
      message: "the URL must be https://",
    });
    await expect(add(`${GATEWAY}/mcp`)).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
      message: "the URL is this Gateway's own address",
    });
    await expect(add("https://crm.apps.example.com/mcp")).rejects.toMatchObject(
      {
        code: "REMOTE_MCP_URL_REFUSED",
        message: "the URL is on this Gateway's app domain (apps.example.com)",
      },
    );
    await expect(add("https://api.openai.com/v1/mcp")).rejects.toMatchObject({
      code: "REMOTE_MCP_URL_REFUSED",
    });
    expect(await db.select().from(apps)).toEqual([]);
  });

  it("refuses a bad credential name or header with the rule's sentence", async () => {
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "bearer", secret: "OPENAI_API_KEY" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("must end in _MCP_TOKEN"),
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "header", header: "Authorization" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("auth.header can't be Authorization"),
    });
  });

  it("refuses a credential name the organization's own server at another origin uses, and lets a second path on the same server share it", async () => {
    await McpAppService.add(
      as(owner, "owner"),
      { url: TREG, auth: { kind: "bearer", secret: "SHARED_MCP_TOKEN" } },
      null,
    );
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: "https://evil.example.net/mcp",
          id: "evil",
          auth: { kind: "bearer", secret: "SHARED_MCP_TOKEN" },
        },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_SECRET_TAKEN",
      message: expect.stringContaining(
        "SHARED_MCP_TOKEN is the credential of an MCP app at https://treg.to",
      ),
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: "https://treg.to/other-mcp",
          id: "treg-two",
          auth: { kind: "bearer", secret: "SHARED_MCP_TOKEN" },
        },
        null,
      ),
    ).resolves.toMatchObject({ appId: "treg-two" });
  });

  it("refuses a credential name another organization's server uses, even at the same origin, without saying where", async () => {
    const other = await seedOrganization(db, "other");
    const otherOwner = await seedMember(db, {
      organizationId: other,
      role: "owner",
    });
    await McpAppService.add(
      as(otherOwner, "owner", other),
      { url: TREG, auth: { kind: "bearer", secret: "OTHER_MCP_TOKEN" } },
      null,
    );
    const refusal = McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "bearer", secret: "OTHER_MCP_TOKEN" } },
      null,
    );
    await expect(refusal).rejects.toMatchObject({
      code: "REMOTE_MCP_SECRET_TAKEN",
      message: expect.stringContaining(
        "OTHER_MCP_TOKEN is the credential of an MCP app at another organization",
      ),
    });
    await expect(refusal).rejects.not.toMatchObject({
      message: expect.stringContaining("at https://treg.to;"),
    });
    // Its own default name is free: one per organization's app.
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "bearer" } },
        null,
      ),
    ).resolves.toMatchObject({ secret: "TREG_MCP_TOKEN" });
  });

  it("refuses an id in use, and brings a removed one back under its row id", async () => {
    const first = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "none" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_EXISTS" });

    await McpAppService.remove(as(owner, "owner"), { id: first.rowId });
    const again = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    expect(again).toMatchObject({ kind: "revived", rowId: first.rowId });
    expect((await row(first.rowId)).status).toBe("active");
    expect(await grantees(first.rowId)).toEqual([owner, admin].sort());
  });

  it("refuses the built-in's id", async () => {
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, id: "dataforseo", auth: { kind: "none" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
  });

  it("answers without a count when the listing fails or can't start yet", async () => {
    hoisted.listing = new Error(
      '"treg" is not a provider app this gateway serves.',
    );
    const added = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    expect(added).toMatchObject({ toolCount: null, toolsStatus: null });
    // The row is written all the same.
    expect((await row(added.rowId)).status).toBe("active");
  });
});

describe("changing a remote MCP app", () => {
  it("stores the risk default, the overrides, the name and the description, bumping the revision each time", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    const first = await McpAppService.update(as(admin, "admin"), {
      id: rowId,
      risk: "read",
      tools: { delete_everything: { risk: "destructive" } },
      name: "Treg",
      description: "Treg's notes.",
    });
    expect(first.remote).toMatchObject({
      risk: "read",
      tools: { delete_everything: { risk: "destructive" } },
      rev: 2,
    });
    const second = await McpAppService.update(as(owner, "owner"), {
      id: rowId,
      tool: { name: "create_note", override: { enabled: false } },
    });
    expect(second.remote.rev).toBe(3);
    const stored = await row(rowId);
    expect(stored).toMatchObject({
      name: "Treg",
      description: "Treg's notes.",
    });
    expect(manifestOf(stored)).toMatchObject({
      name: "Treg",
      remote: {
        url: TREG,
        risk: "read",
        tools: {
          delete_everything: { risk: "destructive" },
          create_note: { enabled: false },
        },
        rev: 3,
      },
    });
  });

  it("refuses a member, and the built-in app (it has no block to change)", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await expect(
      McpAppService.update(as(member, "member"), { id: rowId, risk: "read" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const builtin = await turnOnDataForSeo();
    await expect(
      McpAppService.update(as(admin, "admin"), { id: builtin, risk: "read" }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

describe("turning an MCP app off and on", () => {
  it("keeps access and the snapshot while off, for both kinds", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    const builtin = await turnOnDataForSeo();
    for (const id of [rowId, builtin]) {
      await expect(
        McpAppService.setStatus(as(admin, "admin"), { id, status: "disabled" }),
      ).resolves.toEqual({ status: "disabled", changed: true });
      expect((await row(id)).status).toBe("disabled");
      expect(await grantees(id)).toEqual([owner, admin].sort());
      // Off already: nothing changes.
      await expect(
        McpAppService.setStatus(as(admin, "admin"), { id, status: "disabled" }),
      ).resolves.toEqual({ status: "disabled", changed: false });
      await expect(
        McpAppService.setStatus(as(owner, "owner"), { id, status: "active" }),
      ).resolves.toEqual({ status: "active", changed: true });
      expect((await row(id)).status).toBe("active");
    }
    const [catalog] = await db
      .select()
      .from(appToolCatalogs)
      .where(eq(appToolCatalogs.appRowId, rowId));
    expect(catalog?.toolCount).toBe(3);
  });

  it("refuses a member, and an app that isn't an MCP app", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await expect(
      McpAppService.setStatus(as(member, "member"), {
        id: rowId,
        status: "disabled",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await db.insert(apps).values({
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: acme,
      appSlug: "crm",
      name: "CRM",
      description: "A CRM.",
      hostname: "crm.apps.example.com",
      workerName: "every-acme-crm",
      tier: "service_binding",
      status: "active",
    });
    await expect(
      McpAppService.setStatus(as(admin, "admin"), {
        id: "11111111-1111-4111-8111-111111111111",
        status: "disabled",
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

describe("removing an MCP app", () => {
  it("is the owners': an admin is refused", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await expect(
      McpAppService.remove(as(admin, "admin"), { id: rowId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await row(rowId)).status).toBe("active");
  });

  it("leaves a tombstone: access, the snapshot and what the server listed go; the credential's binding stays", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await db.insert(remoteMcpCredentials).values({
      name: "TREG_MCP_TOKEN",
      origin: "https://treg.to",
      boundBy: "ben@example.com",
      boundAt: new Date(),
    });
    await McpAppService.remove(as(owner, "owner"), { id: rowId });
    expect((await row(rowId)).status).toBe("deleted");
    expect(await grantees(rowId)).toEqual([]);
    const scoped = (table: typeof appTools | typeof remoteMcpTools) =>
      db.select().from(table).where(eq(table.appRowId, rowId));
    expect(await scoped(appTools)).toEqual([]);
    expect(await scoped(remoteMcpTools)).toEqual([]);
    expect(
      await db
        .select()
        .from(appToolCatalogs)
        .where(eq(appToolCatalogs.appRowId, rowId)),
    ).toEqual([]);
    expect(await db.select().from(remoteMcpCredentials)).toHaveLength(1);
    // Removed: nothing to remove again, or to turn on.
    await expect(
      McpAppService.remove(as(owner, "owner"), { id: rowId }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    await expect(
      McpAppService.setStatus(as(owner, "owner"), {
        id: rowId,
        status: "active",
      }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});

describe("refreshing an MCP app's tools", () => {
  it("lists them again now and says which listed names came and went", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    hoisted.listing = [
      TREG_TOOLS[0]!,
      {
        upstreamName: "search",
        localName: "search",
        riskHint: "read",
        risk: "read",
      },
    ];
    await expect(
      McpAppService.refreshTools(as(admin, "admin"), { id: rowId }),
    ).resolves.toEqual({
      status: "ok",
      toolCount: 2,
      added: ["treg_search"],
      removed: ["treg_create_note", "treg_delete_everything"],
      error: null,
    });
    expect(
      (
        await db
          .select({ name: remoteMcpTools.upstreamName })
          .from(remoteMcpTools)
          .where(eq(remoteMcpTools.appRowId, rowId))
      ).map((tool) => tool.name),
    ).toEqual(["getUser", "search"]);
  });

  it("drops the snapshot and says so when the listing can't run", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    hoisted.listing = new Error("unreachable");
    const refreshed = await McpAppService.refreshTools(as(admin, "admin"), {
      id: rowId,
    });
    expect(refreshed).toMatchObject({
      status: null,
      toolCount: 0,
      added: [],
      removed: ["treg_create_note", "treg_delete_everything", "treg_get_user"],
    });
    expect(refreshed.error).toMatch(/tries again on first use/);
    await expect(
      McpAppService.refreshTools(as(member, "member"), { id: rowId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("showing an MCP app", () => {
  it("shows the block, the snapshot and every tool with its listed name, risk and source", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    const shown = await McpAppService.get(as(admin, "admin"), { id: rowId });
    expect(shown).toMatchObject({
      id: rowId,
      appId: "treg",
      name: "treg",
      status: "active",
      kind: "remote",
      origin: "https://treg.to",
      authKind: "none",
      authLabel: "no credential",
      credential: { name: null, set: false, boundTo: null, state: "none" },
      setupCommand: null,
      snapshot: { status: "ok", lastError: null, toolCount: 3 },
      remote: { url: TREG, rev: 1 },
    });
    expect(shown.snapshot.fetchedAt).toBeInstanceOf(Date);
    expect(shown.tools).toEqual([
      {
        upstreamName: "create_note",
        localName: "create_note",
        listedName: "treg_create_note",
        title: null,
        riskHint: "unknown",
        risk: "write",
        source: "default",
        enabled: true,
        listed: true,
        problem: null,
      },
      {
        upstreamName: "delete_everything",
        localName: "delete_everything",
        listedName: "treg_delete_everything",
        title: null,
        riskHint: "destructive",
        risk: "destructive",
        source: "hint",
        enabled: true,
        listed: true,
        problem: null,
      },
      {
        upstreamName: "get-user",
        localName: null,
        listedName: null,
        title: null,
        riskHint: "read",
        risk: "read",
        source: "hint",
        enabled: true,
        listed: false,
        problem: 'skipped: two tools normalize to "get_user"',
      },
      {
        upstreamName: "getUser",
        localName: "get_user",
        listedName: "treg_get_user",
        title: "Get a user",
        riskHint: "read",
        risk: "read",
        source: "hint",
        enabled: true,
        listed: true,
        problem: null,
      },
    ]);
  });

  it("reads an override or the app's default as the source, and keeps an override for a tool the server no longer lists", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await McpAppService.update(as(admin, "admin"), {
      id: rowId,
      risk: "write",
      tools: {
        getUser: { risk: "read", enabled: false },
        gone_tool: { risk: "destructive" },
      },
    });
    const shown = await McpAppService.get(as(admin, "admin"), { id: rowId });
    const byName = Object.fromEntries(
      shown.tools.map((tool) => [tool.upstreamName, tool]),
    );
    // The snapshot is from revision 1, the block at 2: the rule decides.
    expect(byName["getUser"]).toMatchObject({
      risk: "read",
      source: "override",
      enabled: false,
    });
    expect(byName["delete_everything"]).toMatchObject({
      risk: "write",
      source: "app",
    });
    expect(byName["gone_tool"]).toEqual({
      upstreamName: "gone_tool",
      localName: null,
      listedName: null,
      title: null,
      riskHint: "unknown",
      risk: "destructive",
      source: "override",
      enabled: true,
      listed: false,
      problem: "The server doesn't list it now.",
    });
  });

  it("says where a credential stands: not set, set, bound here, bound elsewhere", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "bearer" } },
      null,
    );
    const credential = async () =>
      McpAppService.get(as(admin, "admin"), { id: rowId });
    expect(await credential()).toMatchObject({
      authLabel: "bearer token",
      credential: {
        name: "TREG_MCP_TOKEN",
        set: false,
        boundTo: null,
        state: "not_set",
      },
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      snapshot: { status: null, fetchedAt: null, toolCount: 0 },
      tools: [],
    });
    hoisted.env["TREG_MCP_TOKEN"] = "s3cret";
    expect(await credential()).toMatchObject({
      credential: { set: true, boundTo: null, state: "set" },
      setupCommand: null,
    });
    await db.insert(remoteMcpCredentials).values({
      name: "TREG_MCP_TOKEN",
      origin: "https://treg.to",
      boundBy: "gateway",
      boundAt: new Date(),
    });
    expect(await credential()).toMatchObject({
      credential: { boundTo: "https://treg.to", state: "bound" },
      setupCommand: null,
    });
    await db
      .update(remoteMcpCredentials)
      .set({ origin: "https://old.treg.to" })
      .where(eq(remoteMcpCredentials.name, "TREG_MCP_TOKEN"));
    const elsewhere = await credential();
    expect(elsewhere).toMatchObject({
      // The other origin is never told: on a hosted Gateway it may be another organization's.
      credential: { boundTo: null, state: "bound_elsewhere" },
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
    });
    // The value itself is never in the answer.
    expect(JSON.stringify(elsewhere)).not.toContain("s3cret");
  });

  it("shows a built-in as such, and refuses a member and another organization's row", async () => {
    const builtin = await turnOnDataForSeo();
    await expect(
      McpAppService.get(as(admin, "admin"), { id: builtin }),
    ).resolves.toMatchObject({
      appId: "dataforseo",
      kind: "builtin",
      remote: null,
      tools: [],
    });
    await expect(
      McpAppService.get(as(member, "member"), { id: builtin }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const other = await seedOrganization(db, "other");
    const otherAdmin = await seedMember(db, {
      organizationId: other,
      role: "admin",
    });
    await expect(
      McpAppService.get(as(otherAdmin, "admin", other), { id: builtin }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
  });
});
