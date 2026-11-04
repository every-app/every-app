/**
 * MCP apps from Admin → Apps against a migrated SQLite database
 * (services/McpAppService.ts, the server functions' service): an owner or
 * admin adds a remote MCP server by URL and the rules' row and grants are
 * written, a server with no credential has its tools listed in the same
 * request, a member is refused, a refused URL or a taken credential name
 * comes back with the rule's sentence; an update bumps the block's
 * revision; on and off keep everything; remove is an owner's or admin's
 * and is the tombstone; Refresh tools lists again and says what changed; getMcpApp
 * shows the credential's state and every tool's risk with its source;
 * each add, status change and remove announces its one event on the bus.
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
  risk?: "read" | "write";
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
  /** What each listing was asked with: the row as the sync reads it, and the names before. */
  synced: [] as Array<{
    manifest?: string | null;
    name?: string;
    previousNames?: readonly string[];
  }>,
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
  syncAppTools: async (
    app: {
      rowId: string;
      organizationId: string;
      manifest?: string | null;
      name?: string;
    },
    options: { previousNames?: readonly string[] } = {},
  ) => {
    hoisted.syncs.push(app.rowId);
    hoisted.synced.push({
      manifest: app.manifest,
      name: app.name,
      previousNames: options.previousNames,
    });
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

import { eq, sql } from "drizzle-orm";
import { planProviderAppOn } from "@every-app/perimeter/registry";
import {
  apps,
  appToolCatalogs,
  appTools,
  events,
  oauthClients,
  providerConnections,
  providers,
  remoteMcpTools,
  userAppAccess,
} from "@/db/schema";
import { clearEventSubjectCachesForTests } from "@/server/events/subjects";
import { resetGatewayProvidersForTests } from "@/server/providers";
import { AppCapService } from "@/server/services/AppCapService";
import { AppService } from "@/server/services/AppService";
import {
  McpAppService,
  setMcpOAuthFetchForTests,
} from "@/server/services/McpAppService";
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
    actor: "ben@example.com",
    now: Date.now(),
  });
  await db.insert(apps).values({
    ...plan.app,
    deployedAt: new Date(plan.app.deployedAt ?? Date.now()),
  });
  return plan.app.id;
}

/**
 * The mcp_app.* events written, in the order they were written (SQLite's
 * rowid: two events in the same millisecond have ids in no set order), as
 * a subscriber reads them.
 */
async function mcpAppEvents() {
  const rows = await db
    .select()
    .from(events)
    .orderBy(sql`rowid`);
  return rows
    .filter((event) => event.type.startsWith("mcp_app."))
    .map((event) => ({
      type: event.type,
      organizationId: event.organizationId,
      appRowId: event.appRowId,
      actor: JSON.parse(event.actor) as Record<string, unknown>,
      data: JSON.parse(event.data) as Record<string, unknown>,
    }));
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
    risk: "write",
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
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
  });
  hoisted.background.length = 0;
  hoisted.listing = TREG_TOOLS;
  hoisted.syncs = [];
  hoisted.synced = [];
  clearEventSubjectCachesForTests();
  resetGatewayProvidersForTests();
  setMcpOAuthFetchForTests(undefined);
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
  it("lets an admin add a server with no credential: the rules' row, open to the owners and admins, and its tools listed in the request", async () => {
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
      credentialKind: "none",
      provider: null,
      connectPath: null,
      oauth: null,
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
    // Nobody is granted it: owners and admins open it by their role.
    expect(await grantees(added.rowId)).toEqual([]);
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

  it("writes a static credential as the app's own provider row and answers the command that sets its key", async () => {
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
      authKind: "provider",
      credentialKind: "bearer",
      provider: "treg-mcp",
      secret: "TREG_MCP_TOKEN",
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      connectPath: null,
      oauth: null,
      toolCount: null,
      toolsStatus: null,
    });
    expect(hoisted.syncs).toEqual([]);
    const manifest = manifestOf(await row(added.rowId)) as ReturnType<
      typeof manifestOf
    > & { capabilities?: Record<string, unknown> };
    expect(manifest.remote).toMatchObject({
      auth: { kind: "provider", provider: "treg-mcp" },
      risk: "write",
    });
    expect(Object.keys(manifest.capabilities ?? {})).toEqual(["treg-mcp"]);
    const [stored] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, "treg-mcp"));
    expect(stored?.boundTo).toBeNull();
    expect(JSON.parse(stored!.spec)).toMatchObject({
      id: "treg-mcp",
      hosts: ["treg.to"],
      auth: { kind: "bearer", secret: "TREG_MCP_TOKEN" },
      tags: ["mcp"],
    });

    // A header, set on the Gateway already but never bound to the new row:
    // the command still shows, since the key is read only once bound.
    hoisted.env["DOCS_MCP_TOKEN"] = "set";
    const docs = await McpAppService.add(
      as(owner, "owner"),
      {
        url: "https://docs.example.org/mcp",
        id: "docs",
        auth: { kind: "header", header: "X-Api-Key" },
      },
      null,
    );
    expect(docs).toMatchObject({
      secret: "DOCS_MCP_TOKEN",
      setupCommand: "pnpm everyapp secret set DOCS_MCP_TOKEN",
    });
    const [docsRow] = await db
      .select()
      .from(providers)
      .where(eq(providers.id, "docs-mcp"));
    expect(JSON.parse(docsRow!.spec).auth).toEqual({
      kind: "header",
      secret: "DOCS_MCP_TOKEN",
      header: "X-Api-Key",
    });
  });

  it("keeps the app's own row when it is the same, and replaces it (unbinding the key) when it changed", async () => {
    const first = await McpAppService.add(
      as(owner, "owner"),
      { url: TREG, auth: { kind: "bearer" } },
      null,
    );
    const [written] = await db.select().from(providers);
    // The operator binds the key, as `secret set` does.
    await db
      .update(providers)
      .set({ boundTo: "bound-key-of-the-bearer-spec" })
      .where(eq(providers.id, "treg-mcp"));
    await McpAppService.remove(as(owner, "owner"), { id: first.rowId });
    // Removed: the provider row and its binding stay.
    expect(await db.select().from(providers)).toHaveLength(1);
    // A connection issued under the old spec (an OAuth row's, say).
    await db.insert(providerConnections).values({
      id: "conn-1",
      organizationId: acme,
      providerId: "treg-mcp",
      userId: owner,
      appRowId: first.rowId,
      label: null,
      externalId: null,
      scopes: "[]",
      accessTokenEnc: "sealed",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await McpAppService.add(
      as(owner, "owner"),
      { url: TREG, auth: { kind: "query", param: "key" } },
      null,
    );
    const [replaced] = await db.select().from(providers);
    expect(JSON.parse(replaced!.spec).auth).toEqual({
      kind: "query",
      secret: "TREG_MCP_TOKEN",
      param: "key",
    });
    expect(replaced!.addedAt).toEqual(written!.addedAt);
    expect(replaced!.boundTo).toBe("bound-key-of-the-bearer-spec");
    // Its tokens never reach the replaced spec's server: dropped.
    expect(await db.select().from(providerConnections)).toEqual([]);
  });

  it("refuses a bad header or a query credential without its parameter, with the rule's sentence, and writes nothing", async () => {
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "header", header: "Authorization" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("Authorization"),
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "query" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("query parameter"),
    });
    expect(await db.select().from(apps)).toEqual([]);
    expect(await db.select().from(providers)).toEqual([]);
  });

  it("refuses another organization's app of the same id its own provider row, without writing", async () => {
    const other = await seedOrganization(db, "other");
    const otherOwner = await seedMember(db, {
      organizationId: other,
      role: "owner",
    });
    await McpAppService.add(
      as(otherOwner, "owner", other),
      { url: TREG, auth: { kind: "bearer" } },
      null,
    );
    const [theirs] = await db.select().from(providers);
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "header", header: "X-Key" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("another organization's MCP app"),
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: TREG,
          id: "mine",
          auth: { kind: "provider", provider: "treg-mcp" },
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
    expect(await db.select().from(providers)).toEqual([theirs]);
    // Removed, its row and key stay the other organization's: still refused.
    const [theirApp] = await db.select().from(apps);
    await McpAppService.remove(as(otherOwner, "owner", other), {
      id: theirApp!.id,
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "bearer" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_INVALID",
      message: expect.stringContaining("another organization's MCP app"),
    });
    // Under another id, its own row: fine.
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, id: "treg-acme", auth: { kind: "bearer" } },
        null,
      ),
    ).resolves.toMatchObject({ provider: "treg-acme-mcp" });
  });

  it("uses an existing provider only for a URL on its hosts, and lets a reserved host through only for its own provider", async () => {
    // A catalog provider: its key is sent to its own hosts alone.
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: TREG,
          auth: { kind: "provider", provider: "elevenlabs" },
        },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_PROVIDER_HOST",
      message: expect.stringContaining("not to treg.to"),
    });
    const added = await McpAppService.add(
      as(admin, "admin"),
      {
        url: "https://api.elevenlabs.io/v1/mcp",
        id: "voices",
        auth: { kind: "provider", provider: "elevenlabs" },
      },
      null,
    );
    expect(added).toMatchObject({
      authKind: "provider",
      credentialKind: "provider",
      provider: "elevenlabs",
      secret: "ELEVENLABS_API_KEY",
      setupCommand: "pnpm everyapp secret set ELEVENLABS_API_KEY",
    });
    expect(await db.select().from(providers)).toEqual([]);
    // The same reserved host with no provider, or with its own row: refused.
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: "https://api.elevenlabs.io/v1/mcp",
          id: "voices-two",
          auth: { kind: "bearer" },
        },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_URL_REFUSED" });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "provider", provider: "nope" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_INVALID" });
  });

  it("adds an OAuth server: discovery and client registration from the Gateway, the client sealed and bound to the row, a connect link", async () => {
    const fetched: string[] = [];
    let registered: Record<string, unknown> | null = null;
    setMcpOAuthFetchForTests(async (input, init) => {
      fetched.push(input);
      if (
        input.startsWith("https://treg.to/.well-known/oauth-protected-resource")
      ) {
        return Response.json({
          resource: TREG,
          authorization_servers: ["https://auth.treg.to"],
          scopes_supported: ["mcp"],
        });
      }
      if (
        input.startsWith(
          "https://auth.treg.to/.well-known/oauth-authorization-server",
        )
      ) {
        return Response.json({
          issuer: "https://auth.treg.to",
          authorization_endpoint: "https://auth.treg.to/authorize",
          token_endpoint: "https://auth.treg.to/token",
          registration_endpoint: "https://auth.treg.to/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (input === "https://auth.treg.to/register") {
        registered = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json(
          {
            client_id: "dcr-client",
            client_secret: "dcr-secret-value",
            token_endpoint_auth_method: "client_secret_basic",
          },
          { status: 201 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const added = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, name: "Treg", auth: { kind: "oauth" } },
      null,
    );
    expect(added).toMatchObject({
      authKind: "provider",
      credentialKind: "oauth",
      provider: "treg-mcp",
      secret: null,
      setupCommand: null,
      connectPath: "/connect/treg-mcp?app=treg&return=%2F%3Fmcp%3Dtreg",
      oauth: { issuer: "https://auth.treg.to", registered: "dcr" },
      toolCount: null,
    });
    expect(registered).toMatchObject({
      redirect_uris: [`${GATEWAY}/connect/treg-mcp/callback`],
    });
    const [spec] = await db.select().from(providers);
    expect(JSON.parse(spec!.spec).auth).toMatchObject({
      kind: "oauth2-user",
      clientId: "TREG_MCP_CLIENT_ID",
      clientSecret: "TREG_MCP_CLIENT_SECRET",
      inject: "basic",
      resource: TREG,
      issuer: "https://auth.treg.to",
    });
    const [client] = await db.select().from(oauthClients);
    expect(client).toMatchObject({
      providerId: "treg-mcp",
      clientId: "dcr-client",
    });
    expect(client!.clientSecretEnc).not.toContain("dcr-secret-value");
    expect(client!.boundTo).toContain("https://auth.treg.to");
    // The answer never carries the client's secret.
    expect(JSON.stringify(added)).not.toContain("dcr-secret-value");
    // Each member connects their own: the dialog reads it.
    expect(
      await McpAppService.connection(as(member, "member"), { appId: "treg" }),
    ).toEqual({
      providerName: "Treg MCP server",
      connectPath: "/connect/treg-mcp?app=treg&return=%2F%3Fmcp%3Dtreg",
      connection: null,
    });
    const shown = await McpAppService.get(as(admin, "admin"), {
      id: added.rowId,
    });
    expect(shown.credential).toMatchObject({
      kind: "oauth",
      provider: "treg-mcp",
      own: true,
      state: "not_connected",
      connections: 0,
      viewer: null,
    });
  });

  it("refuses an OAuth server it can't register with until a client is pasted, and takes a pasted one from the form alone", async () => {
    setMcpOAuthFetchForTests(async (input) => {
      if (input.includes("oauth-protected-resource")) {
        return Response.json({
          resource: TREG,
          authorization_servers: ["https://auth.treg.to"],
        });
      }
      if (
        input.startsWith(
          "https://auth.treg.to/.well-known/oauth-authorization-server",
        )
      ) {
        return Response.json({
          issuer: "https://auth.treg.to",
          authorization_endpoint: "https://auth.treg.to/authorize",
          token_endpoint: "https://auth.treg.to/token",
          code_challenge_methods_supported: ["S256"],
        });
      }
      return new Response("not found", { status: 404 });
    });
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "oauth" } },
        null,
      ),
    ).rejects.toMatchObject({
      code: "REMOTE_MCP_OAUTH_NO_CLIENT",
      message: expect.stringContaining(`${GATEWAY}/connect/treg-mcp/callback`),
    });
    expect(await db.select().from(apps)).toEqual([]);
    expect(await db.select().from(providers)).toEqual([]);
    // A tool never takes a pasted client.
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        {
          url: TREG,
          auth: { kind: "oauth", clientId: "pasted", clientSecret: "shh" },
        },
        null,
        { allowPastedClient: false },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const added = await McpAppService.add(
      as(admin, "admin"),
      {
        url: TREG,
        auth: { kind: "oauth", clientId: "pasted", clientSecret: "shh" },
      },
      null,
    );
    expect(added.oauth).toEqual({
      issuer: "https://auth.treg.to",
      registered: "pasted",
    });
    const [client] = await db.select().from(oauthClients);
    expect(client).toMatchObject({ clientId: "pasted" });
  });

  it("refuses an OAuth server whose metadata can't be read", async () => {
    setMcpOAuthFetchForTests(async () => new Response("nope", { status: 404 }));
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: TREG, auth: { kind: "oauth" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_OAUTH_DISCOVERY" });
    expect(await db.select().from(apps)).toEqual([]);
  });

  it("refuses a cap on a remote MCP app: it isn't metered", async () => {
    const { rowId } = await McpAppService.add(
      as(owner, "owner"),
      { url: TREG, name: "Treg", auth: { kind: "none" } },
      null,
    );
    await expect(
      AppCapService.setMonthlyCap(as(owner, "owner"), {
        appRowId: rowId,
        costUsd: 10,
      }),
    ).rejects.toMatchObject({
      code: "APP_NOT_METERED",
      message:
        "Treg is an MCP server added by URL; it isn't metered, so it takes no cap.",
    });
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
    expect(await grantees(first.rowId)).toEqual([]);
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
      tools: { delete_everything: { risk: "write" } },
      name: "Treg",
      description: "Treg's notes.",
    });
    expect(first.remote).toMatchObject({
      risk: "read",
      tools: { delete_everything: { risk: "write" } },
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
          delete_everything: { risk: "write" },
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
      expect(await grantees(id)).toEqual([]);
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
  it("is an owner's or admin's: a member is refused, an admin removes", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await expect(
      McpAppService.remove(as(member, "member"), { id: rowId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await row(rowId)).status).toBe("active");
    await McpAppService.remove(as(admin, "admin"), { id: rowId });
    expect((await row(rowId)).status).toBe("deleted");
  });

  it("leaves a tombstone: access, the snapshot and what the server listed go; its provider row stays", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "bearer" } },
      null,
    );
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
    expect(await db.select().from(providers)).toHaveLength(1);
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
      credential: { kind: "none", name: null, set: false, state: "none" },
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
        risk: "write",
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
        gone_tool: { risk: "read" },
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
      risk: "read",
      source: "override",
      enabled: true,
      listed: false,
      problem: "The server doesn't list it now.",
    });
  });

  it("says where a key stands: not set, set for another spec of its row, ready", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, name: "Treg", auth: { kind: "bearer" } },
      null,
    );
    const credential = async () => {
      resetGatewayProvidersForTests();
      return McpAppService.get(as(admin, "admin"), { id: rowId });
    };
    expect(await credential()).toMatchObject({
      credential: {
        kind: "api_key",
        provider: "treg-mcp",
        providerName: "Treg MCP server",
        own: true,
        name: "TREG_MCP_TOKEN",
        set: false,
        state: "not_set",
        connectPath: null,
      },
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
      snapshot: { status: null, fetchedAt: null, toolCount: 0 },
      tools: [],
    });
    hoisted.env["TREG_MCP_TOKEN"] = "s3cret";
    // Set but not bound to the row as it is: sent nowhere until `secret set`.
    expect(await credential()).toMatchObject({
      credential: { set: true, state: "bound_elsewhere" },
      setupCommand: "pnpm everyapp secret set TREG_MCP_TOKEN",
    });
    const [stored] = await db.select().from(providers);
    const { providerBindingKey, parseProviderSpec } = await import(
      "@every-app/sdk/internal"
    );
    const parsed = parseProviderSpec(JSON.parse(stored!.spec));
    if (!parsed.ok) throw new Error("the row's spec should parse");
    await db
      .update(providers)
      .set({ boundTo: providerBindingKey(parsed.capability) });
    const ready = await credential();
    expect(ready).toMatchObject({
      credential: { set: true, state: "ready" },
      setupCommand: null,
    });
    // The value itself is never in the answer.
    expect(JSON.stringify(ready)).not.toContain("s3cret");
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

describe("the events an MCP app's changes announce", () => {
  it("announces an add once: mcp_app.added, kind remote, the app named, the adding member the actor", async () => {
    const added = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      "admin@example.com",
    );
    expect(await mcpAppEvents()).toEqual([
      {
        type: "mcp_app.added",
        organizationId: acme,
        appRowId: added.rowId,
        actor: expect.objectContaining({ kind: "user", id: admin }),
        data: {
          app: { id: "treg", rowId: added.rowId, name: "treg" },
          kind: "remote",
        },
      },
    ]);
  });

  it("announces nothing for an add the rules refuse", async () => {
    await expect(
      McpAppService.add(
        as(admin, "admin"),
        { url: "http://treg.to/mcp/", auth: { kind: "none" } },
        null,
      ),
    ).rejects.toMatchObject({ code: "REMOTE_MCP_URL_REFUSED" });
    expect(await mcpAppEvents()).toEqual([]);
  });

  it("lists a remote server's tools from its own row, manifest and name, so the sync reaches the server and not a built-in of that id", async () => {
    await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, name: "Treg", auth: { kind: "none" } },
      null,
    );
    expect(hoisted.synced).toHaveLength(1);
    expect(hoisted.synced[0]!.name).toBe("Treg");
    expect(
      JSON.parse(hoisted.synced[0]!.manifest ?? "{}") as {
        remote?: { url: string };
      },
    ).toMatchObject({ remote: { url: TREG } });
  });

  it("announces a status that changed, mcp_app.disabled then mcp_app.enabled, with each row's kind, and nothing when it was already so", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    const builtin = await turnOnDataForSeo();
    for (const id of [rowId, builtin]) {
      await McpAppService.setStatus(as(admin, "admin"), {
        id,
        status: "disabled",
      });
      await McpAppService.setStatus(as(admin, "admin"), {
        id,
        status: "disabled",
      });
      await McpAppService.setStatus(as(owner, "owner"), {
        id,
        status: "active",
      });
    }
    const changes = (await mcpAppEvents()).filter(
      (event) => event.type !== "mcp_app.added",
    );
    expect(
      changes.map((event) => ({
        type: event.type,
        appRowId: event.appRowId,
        actor: event.actor["id"],
        data: event.data,
      })),
    ).toEqual([
      {
        type: "mcp_app.disabled",
        appRowId: rowId,
        actor: admin,
        data: { app: { id: "treg", rowId, name: "treg" }, kind: "remote" },
      },
      {
        type: "mcp_app.enabled",
        appRowId: rowId,
        actor: owner,
        data: { app: { id: "treg", rowId, name: "treg" }, kind: "remote" },
      },
      {
        type: "mcp_app.disabled",
        appRowId: builtin,
        actor: admin,
        data: {
          app: expect.objectContaining({ id: "dataforseo", rowId: builtin }),
          kind: "builtin",
        },
      },
      {
        type: "mcp_app.enabled",
        appRowId: builtin,
        actor: owner,
        data: {
          app: expect.objectContaining({ id: "dataforseo", rowId: builtin }),
          kind: "builtin",
        },
      },
    ]);
  });

  it("announces a remove once, mcp_app.removed with the row's kind, and nothing for a refused one", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    const builtin = await turnOnDataForSeo();
    await expect(
      McpAppService.remove(as(member, "member"), { id: rowId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await McpAppService.remove(as(owner, "owner"), { id: rowId });
    await McpAppService.remove(as(owner, "owner"), { id: builtin });
    await expect(
      McpAppService.remove(as(owner, "owner"), { id: rowId }),
    ).rejects.toMatchObject({ code: "APP_NOT_FOUND" });
    const removed = (await mcpAppEvents()).filter(
      (event) => event.type === "mcp_app.removed",
    );
    expect(
      removed.map((event) => ({
        appRowId: event.appRowId,
        actor: event.actor["id"],
        kind: event.data["kind"],
      })),
    ).toEqual([
      { appRowId: rowId, actor: owner, kind: "remote" },
      { appRowId: builtin, actor: owner, kind: "builtin" },
    ]);
  });

  it("says kind remote when a remote server's row is deleted from the Apps list", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    await AppService.delete(as(owner, "owner"), rowId);
    const removed = (await mcpAppEvents()).filter(
      (event) => event.type === "mcp_app.removed",
    );
    expect(removed.map((event) => event.data)).toEqual([
      { app: { id: "treg", rowId, name: "treg" }, kind: "remote" },
    ]);
  });

  it("hands Refresh tools' listing the names the dropped snapshot held, so the same tools are no change", async () => {
    const { rowId } = await McpAppService.add(
      as(admin, "admin"),
      { url: TREG, auth: { kind: "none" } },
      null,
    );
    // The add's own listing compares against the stored snapshot.
    expect(hoisted.synced[0]!.previousNames).toBeUndefined();
    await McpAppService.refreshTools(as(admin, "admin"), { id: rowId });
    expect(hoisted.synced[1]!.previousNames).toEqual([
      "create_note",
      "delete_everything",
      "get_user",
    ]);
  });
});
