/**
 * The catalog sync end to end against a migrated SQLite database: the
 * snapshot in D1, the real registry and perimeter, and a real SDK app
 * (`everyApp` + `defineTools`) behind its service binding. The Gateway's
 * own `/mcp` and the consent page serve from these snapshots.
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
import { eq } from "drizzle-orm";
import {
  handleGatewayRequest,
  type GatewayDeps,
  type ParsedHost,
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
import { apps, appToolCatalogs, appTools } from "@/db/schema";
import { createProdAuthenticator } from "@/perimeter/betterAuthAuthenticator";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { AppService } from "@/server/services/AppService";
import { UserPatService } from "@/server/services/UserPatService";
import { deployLiveApp } from "@/test/registry";
import { createTestDb, seedMember, seedOrganization } from "@/test/sqlite-db";
import {
  claimCatalogSync,
  clearCatalogSyncClaimsForTests,
  syncAppTools,
  syncCatalogsWithin,
  type SyncableApp,
} from "./catalog-sync";
import { resetToolBusForTests } from "./runtime";

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
      risk: "write",
      destructive: true,
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
  const worker = everyApp(async () => new Response("todo app page"), {
    publicKeys: [keys.publicKeyPem],
    issuer: "https://gateway.example.com",
    ...(options.contract === false
      ? {}
      : { tools: todoTools(options.extraTool) }),
  });
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
      return worker.fetch(
        request,
        // Deployed as everyAppWorker() does: its name is the audience.
        { EVERYAPP_AUDIENCE: WORKER },
        // TODO(integration): PR 2 types everyApp()'s ctx as the runtime ExecutionContext.
        { waitUntil: () => undefined } as unknown as ExecutionContext,
      );
    },
  };
}

function gatewayDeps(): GatewayDeps {
  return {
    env: hoisted.env,
    registry: new DrizzleAppRegistry(db as never),
    authenticator: createProdAuthenticator(),
    privateKeyPem: keys.privateKeyPem,
    issuer: "https://gateway.example.com",
    resolveApp: (host: ParsedHost, registry) =>
      registry.findByHostname(host.host),
  };
}

async function personalToken(
  access?: "read" | "full",
  options: { appRowId?: string } = {},
): Promise<string> {
  const { plaintext } = await UserPatService.create({
    userId: ownerId,
    organizationId,
    name: "claude code",
    access,
    appRowId: options.appRowId ?? null,
  });
  return plaintext;
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

beforeAll(async () => {
  // The first sync pays for loading the ToolBus; no test should pay it
  // against a budget.
  await import("@every-app/toolbus");
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
  resetToolBusForTests();
  deployApp();
});

describe("catalog sync", () => {
  it("snapshots the app's tools with one invocation and a system token", async () => {
    const result = await syncAppTools(syncable());

    expect(result).toMatchObject({
      status: "ok",
      toolCount: 3,
      // The SDK the test app runs reports its own version.
      sdkVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
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
      ["delete_todo", "write"],
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

  it("syncs several apps at once within a budget, and finishes a slow one after it", async () => {
    // A second app whose catalog answers only once the test lets it.
    const notesRowId = await deployLive("notes", {
      id: "notes",
      name: "Notes",
    });
    const [notesRow] = await db
      .select()
      .from(apps)
      .where(eq(apps.id, notesRowId));
    const notesWorker = everyApp(async () => new Response("notes app page"), {
      publicKeys: [keys.publicKeyPem],
      issuer: "https://gateway.example.com",
      tools: defineTools({
        list_notes: {
          description: "List notes.",
          risk: "read",
          input: objectInput<Record<string, never>>({}, []),
          handler: () => ({ notes: [] }),
        },
      }),
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notesRequests: Request[] = [];
    hoisted.env[`APP__${notesRow!.workerName}`] = {
      fetch: async (request: Request) => {
        notesRequests.push(request);
        await released;
        return notesWorker.fetch(
          request,
          { EVERYAPP_AUDIENCE: notesRow!.workerName },
          { waitUntil: () => undefined } as unknown as ExecutionContext,
        );
      },
    };
    const notes: SyncableApp = {
      rowId: notesRowId,
      organizationId,
      appSlug: "notes",
      hostname: notesRow!.hostname!,
      workerName: notesRow!.workerName!,
      tier: "service_binding",
      versionId: notesRow!.versionId,
    };

    const statuses = await syncCatalogsWithin(
      [syncable(), notes],
      250,
      "consent",
    );
    expect([...statuses]).toEqual([[appRowId, "ok"]]);
    expect(notesRequests).toHaveLength(1);
    expect(hoisted.waitUntil).toHaveBeenCalledTimes(1);
    expect(await db.select().from(appToolCatalogs)).toHaveLength(1);

    release();
    await Promise.all(hoisted.waitUntil.mock.calls.map(([task]) => task));
    const rows = await db.select().from(appToolCatalogs);
    expect(rows.map((row) => [row.appRowId, row.status]).sort()).toEqual(
      [
        [appRowId, "ok"],
        [notesRowId, "ok"],
      ].sort(),
    );
  });

  it("skips an app another request claimed moments ago", async () => {
    expect(claimCatalogSync(appRowId)).toBe(true);
    const statuses = await syncCatalogsWithin([syncable()], 250, "first_use");
    expect(statuses.size).toBe(0);
    expect(appRequests).toHaveLength(0);
    expect(hoisted.waitUntil).not.toHaveBeenCalled();
  });
});
