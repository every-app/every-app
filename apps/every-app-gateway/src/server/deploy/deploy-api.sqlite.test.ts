/**
 * The hosted deploy API end to end, in process: the real worker entry
 * (server.ts) on SQLite, deploy keys made by UserPatService, and the CLI's
 * fake Cloudflare account behind the deployer's REST calls (a Workers for
 * Platforms namespace that parses real multipart uploads and keeps their
 * bindings, D1 on SQLite) and behind the gateway's DISPATCHER binding.
 *
 * An owner registers and deploys a third-party app built the way `everyapp
 * deploy --gateway` builds it (everyAppWorker()'s tenant-neutral production
 * build, placeholders throughout): the row is written on the dispatch tier, the bindings uploaded
 * are the deployer's own and read back, and a request to the app's host
 * dispatches through getAppFetcher. A gateway without the launch gate has
 * no deploy API; a member, an access token, a foreign binding and a
 * read-back that doesn't match are refused, and a refused redeploy leaves
 * the app's schema and registry row as they were.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
  pending: [] as Promise<unknown>[],
}));

vi.mock("cloudflare:workers", () => ({
  env: hoisted.env,
  waitUntil: (promise: Promise<unknown>) => hoisted.pending.push(promise),
  WorkerEntrypoint: class {},
}));
vi.mock("@/db", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  const schema = await import("@/db/schema");
  return { db: testDbProxy(hoisted.testDb), schema };
});
vi.mock("drizzle-orm/d1", async () => {
  const { testDbProxy } = await import("@/test/sqlite-db");
  return { drizzle: () => testDbProxy(hoisted.testDb) };
});
vi.mock("better-auth/tanstack-start", () => ({
  tanstackStartCookies: () => ({ id: "tanstack-start-cookies" }),
}));
// The control plane answers an unknown path as TanStack Start does: 404.
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: async () => new Response("control plane", { status: 404 }),
  },
}));

import { generateKeyPairSync } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { decodeJwt } from "jose";
import { createCloudflareRest } from "@every-app/cf-rest";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import {
  apps,
  appToolCatalogs,
  deployJobs,
  members,
  organizations,
  userAccessTokens,
  users,
} from "@/db/schema";
import server, { clearHostnameCacheForTests } from "@/server";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { DeployJobRepository } from "@/server/repositories/DeployJobRepository";
import { UserPatService } from "@/server/services/UserPatService";
import { createTestDb } from "@/test/sqlite-db";

const GATEWAY = "https://gateway.example.com";
const NAMESPACE = "every-app-apps";
const TOKEN = "fake-cloudflare-api-token";
const ACCOUNT_ID = "0123456789abcdef0123456789abcd01";

/** What the test uses of the CLI's FakeCloudflare (packages/cli/src/test). */
interface FakeAccount {
  api: { fetch: typeof fetch };
  workers: Map<string, unknown>;
  databases: Map<
    string,
    { name: string; db: { all(sql: string): Record<string, unknown>[] } }
  >;
  dispatchNamespaces: Map<
    string,
    {
      scripts: Map<
        string,
        {
          bindings: Record<string, unknown>[];
          tags: string[];
          limits?: unknown;
          modules: Record<string, unknown>;
        }
      >;
    }
  >;
  dispatcher(
    namespace: string,
    respond?: (request: Request, script: { name: string }) => Response,
  ): {
    calls: Array<{ name: string; options: Record<string, any> | undefined }>;
  };
}

const TODO = {
  id: "todo",
  name: "Todos",
  resources: {
    d1: ["DB"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
};

let account: FakeAccount;
let dispatcher: ReturnType<FakeAccount["dispatcher"]>;
let db: TestDb;
let keys: { privateKey: string; publicKey: string };
let acme: string;
/** Acme's owner: a deploy key and an access token. */
let ownerDeployKey: string;
let ownerAccessToken: string;
/** Acme's member: a deploy key. */
let memberDeployKey: string;
/** The identities the dispatched app received. */
const received: Array<string | null> = [];
/** The paths the gateway dispatched to the app, in order. */
const dispatched: string[] = [];
/** What the app answers the gateway's catalog request with. */
const CATALOG = {
  v: 1,
  hash: `sha256:${"a".repeat(64)}`,
  sdk: "0.3.0",
  tools: [
    {
      name: "list_todos",
      description: "List todos.",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};
/** Rewrites the API's answers, as a Cloudflare that misbehaves would. */
let tamper: ((url: URL, response: Response) => Promise<Response>) | null = null;

beforeAll(() => {
  keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }) as unknown as { privateKey: string; publicKey: string };
});

/** The app's Build Output config, as `everyapp deploy --gateway` builds it. */
function builtWorker(manifest: Record<string, unknown> = TODO) {
  // The tenant-neutral production build, as `everyapp deploy` runs it.
  vi.stubEnv("EVERYAPP_BUILD", "1");
  try {
    const { entrypoint: _entrypoint, ...worker } = everyAppWorker({
      manifest: manifest as typeof TODO,
      entrypoint: "./src/entry.worker.ts",
      ctx: { mode: "production" },
    });
    return {
      ...structuredClone(worker),
      manifest: { type: "partial", mainModule: "index.js", modules: {} },
    } as Record<string, any>;
  } finally {
    vi.unstubAllEnvs();
  }
}

function upload(worker = builtWorker(), manifest: unknown = TODO): FormData {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set(
    "stamp",
    JSON.stringify({ protocol: 1, sdkVersion: "0.3.0", cliVersion: "0.3.0" }),
  );
  form.set("worker", JSON.stringify(worker));
  form.set("module:index.js", new File(["export default {}"], "index.js"));
  form.set("module:index.js.map", new File(["{}"], "index.js.map"));
  form.set("module:.vite/manifest.json", new File(["{}"], "manifest.json"));
  form.set(
    "asset:/favicon.ico",
    new File([new Uint8Array([1, 2, 3])], "favicon.ico"),
  );
  form.set(
    "migration:0000_init.sql",
    new File(
      [
        "CREATE TABLE todos (id text PRIMARY KEY);\n--> statement-breakpoint\nCREATE INDEX todos_id ON todos (id);",
      ],
      "0000_init.sql",
    ),
  );
  return form;
}

function api(
  pathname: string,
  { token = ownerDeployKey, ...init }: RequestInit & { token?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "gateway.example.com");
  headers.set("authorization", `Bearer ${token}`);
  return server.fetch(
    new Request(`${GATEWAY}${pathname}`, { ...init, headers }),
  );
}

async function register(token = ownerDeployKey): Promise<Response> {
  return api(`/api/v1/orgs/${acme}/apps`, {
    token,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: "todo", manifest: TODO }),
  });
}

async function deploy(
  form = upload(),
  token = ownerDeployKey,
): Promise<Response> {
  const response = await api(`/api/v1/orgs/${acme}/apps/todo/deploys`, {
    token,
    method: "POST",
    body: form,
  });
  await Promise.all(hoisted.pending.splice(0));
  return response;
}

const script = () =>
  account.dispatchNamespaces.get(NAMESPACE)?.scripts.get("every-acme-todo");

async function row() {
  const [app] = await db.select().from(apps).where(eq(apps.appSlug, "todo"));
  return app;
}

async function addMember(name: string, role: string): Promise<string> {
  const userId = `user-${name}`;
  await db.insert(users).values({
    id: userId,
    name,
    email: `${name}@example.com`,
    emailVerified: true,
  });
  await db.insert(members).values({
    id: `member-${name}`,
    organizationId: acme,
    userId,
    role,
    createdAt: new Date(),
  });
  return userId;
}

async function token(userId: string, scopes?: string[]): Promise<string> {
  const { plaintext } = await UserPatService.create({
    userId,
    organizationId: acme,
    name: "ci",
    ...(scopes ? { scopes } : {}),
  });
  return plaintext;
}

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  hoisted.pending.length = 0;
  received.length = 0;
  dispatched.length = 0;
  tamper = null;
  clearHostnameCacheForTests();
  clearOrgContextCacheForTests();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  // Loaded by path, not imported: the fake belongs to the CLI's tests.
  const fakeModule = "../../../../../packages/cli/src/test/fakeCloudflare";
  const { FakeCloudflare } = (await import(/* @vite-ignore */ fakeModule)) as {
    FakeCloudflare: new () => FakeAccount;
  };
  account = new FakeCloudflare();
  // The gateway Worker the AppGateway service binding names.
  account.workers.set("every-app-gateway", {
    versions: ["gw"],
    config: {},
    secrets: {},
  });
  await createCloudflareRest({
    apiToken: TOKEN,
    accountId: ACCOUNT_ID,
    fetch: account.api.fetch,
  }).dispatchNamespaces.create(NAMESPACE);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await account.api.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : String(input));
      return tamper ? tamper(url, response) : response;
    },
  );
  dispatcher = account.dispatcher(NAMESPACE, (request) => {
    const { pathname } = new URL(request.url);
    dispatched.push(pathname);
    if (pathname === "/__everyapp/tools/list") return Response.json(CATALOG);
    received.push(request.headers.get("x-everyapp-identity"));
    return new Response("todo app");
  });

  Object.assign(hoisted.env, {
    GATEWAY_DEPLOYMENT_MODE: "hosted",
    THIRD_PARTY_DEPLOYS: "on",
    THIRD_PARTY_DOMAIN: "everyapp.dev",
    GATEWAY_URL: GATEWAY,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
    JWT_PRIVATE_KEY: keys.privateKey,
    JWT_PUBLIC_KEY: keys.publicKey,
    DB: { prepare: () => undefined },
    CF_DEPLOY_TOKEN: TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    DISPATCH_NAMESPACE: NAMESPACE,
    DISPATCHER: dispatcher,
  });

  db = await createTestDb();
  hoisted.testDb.current = db;
  acme = "org-acme";
  await db
    .insert(organizations)
    .values({ id: acme, name: "Acme", slug: "acme", createdAt: new Date() });
  const owner = await addMember("alice", "owner");
  const member = await addMember("bob", "member");
  ownerDeployKey = await token(owner, ["deploy"]);
  ownerAccessToken = await token(owner);
  memberDeployKey = await token(member, ["deploy"]);
});

describe("hosted deploy API (SQLite, fake Cloudflare)", () => {
  it("registers, deploys and verifies a third-party app, which then dispatches", async () => {
    const whoami = await api("/api/v1/deploy-key");
    expect(await whoami.json()).toMatchObject({
      organizationId: acme,
      role: "owner",
    });

    const registered = await register();
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({
      app: {
        id: "todo",
        workerName: "every-acme-todo",
        hostname: "todo-acme.everyapp.dev",
        status: "pending",
        tier: "dispatch",
      },
    });

    const deployed = await deploy();
    expect(deployed.status).toBe(202);
    const { job } = (await deployed.json()) as { job: Record<string, any> };
    expect(job).toMatchObject({
      status: "succeeded",
      error: null,
      app: { status: "binding", url: "https://todo-acme.everyapp.dev" },
    });
    expect(await row()).toMatchObject({
      tier: "dispatch",
      scope: "org",
      hostname: "todo-acme.everyapp.dev",
      workerName: "every-acme-todo",
      status: "binding",
      deployedByActor: expect.stringMatching(/^deploy-key:/),
    });
    const polled = await api(`/api/v1/orgs/${acme}/deploys/${job["id"]}`);
    expect(((await polled.json()) as { job: unknown }).job).toMatchObject({
      status: "succeeded",
    });

    // The deploy took the app's tool snapshot once it went live, before
    // anyone opens the consent page or calls /mcp.
    expect(dispatched).toEqual(["/__everyapp/tools/list"]);
    const live = (await row())!;
    expect(live.versionId).toEqual(expect.any(String));
    const [catalog] = await db.select().from(appToolCatalogs);
    expect(catalog).toMatchObject({
      appRowId: live.id,
      versionId: live.versionId,
      status: "ok",
      toolCount: 1,
    });

    // Its own database, created, named after its Worker and migrated.
    const [databaseId, database] = [...account.databases].find(
      ([, entry]) => entry.name === "every-acme-todo",
    )!;
    expect(database.db.all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(
      database.db.all("SELECT name FROM sqlite_master WHERE name = 'todos'"),
    ).toHaveLength(1);

    // Every binding the deployer's: nothing of the sentinel inputs is left.
    const uploaded = script()!;
    expect(JSON.stringify(uploaded.bindings)).not.toContain("sentinel");
    expect(uploaded.bindings).toEqual(
      expect.arrayContaining([
        { type: "plain_text", name: "EVERYAPP_APP_ID", text: "todo" },
        {
          type: "plain_text",
          name: "EVERYAPP_AUDIENCE",
          text: "every-acme-todo",
        },
        {
          type: "plain_text",
          name: "EVERYAPP_IDENTITY_PUBLIC_KEYS",
          text: JSON.stringify([keys.publicKey]),
        },
        { type: "plain_text", name: "EVERYAPP_IDENTITY_ISSUER", text: GATEWAY },
        { type: "plain_text", name: "GATEWAY_URL", text: GATEWAY },
        { type: "plain_text", name: "EVERY_APP_ORG_ID", text: acme },
        {
          type: "service",
          name: "EVERY_APP_GATEWAY",
          service: "every-app-gateway",
          entrypoint: "AppGateway",
          props: {
            organizationId: acme,
            appId: "todo",
            workerName: "every-acme-todo",
          },
        },
        { type: "d1", name: "DB", id: databaseId },
        {
          type: "durable_object_namespace",
          name: "USER_SYNC",
          class_name: "UserSyncDO",
        },
        { type: "version_metadata", name: "CF_VERSION_METADATA" },
      ]),
    );
    expect(uploaded.bindings).toHaveLength(10);
    expect(uploaded.tags).toEqual([`org-${acme}`, "app-todo", "kind-org"]);
    expect(uploaded.limits).toEqual({ cpu_ms: 5_000, subrequests: 200 });
    // Modules only: not the Vite manifest beside them.
    expect(Object.keys(uploaded.modules).sort()).toEqual([
      "index.js",
      "index.js.map",
    ]);

    // The owner opens it on its host, through the dispatch namespace.
    const opened = await server.fetch(
      new Request("https://todo-acme.everyapp.dev/", {
        headers: {
          host: "todo-acme.everyapp.dev",
          authorization: `Bearer ${ownerAccessToken}`,
        },
      }),
    );
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe("todo app");
    expect(dispatcher.calls.at(-1)).toMatchObject({
      name: "every-acme-todo",
      options: {
        limits: { cpuMs: 5_000, subRequests: 200 },
        outbound: {
          everyapp: {
            appId: "todo",
            organizationId: acme,
            workerName: "every-acme-todo",
          },
        },
      },
    });
    expect(decodeJwt(received.at(-1)!)).toMatchObject({
      aud: "every-acme-todo",
      org_id: acme,
    });
    expect((await row())?.status).toBe("active");
  });

  it("redeploys the app, adding a Durable Object class with the next migration", async () => {
    await register();
    expect(((await (await deploy()).json()) as any).job.status).toBe(
      "succeeded",
    );
    const withChat = {
      ...TODO,
      resources: {
        ...TODO.resources,
        durableObjects: [
          ...TODO.resources.durableObjects,
          { name: "CHAT", className: "ChatDO" },
        ],
      },
    };
    const again = await deploy(upload(builtWorker(withChat), withChat));
    expect(((await again.json()) as any).job).toMatchObject({
      status: "succeeded",
    });
    expect(script()!.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "durable_object_namespace",
          name: "CHAT",
          class_name: "ChatDO",
        },
      ]),
    );
    // One database, kept.
    expect(
      [...account.databases.values()].filter(
        (d) => d.name === "every-acme-todo",
      ),
    ).toHaveLength(1);
  });

  it("has no deploy API without the launch gate, or on a self-hosted gateway", async () => {
    for (const gate of [
      { THIRD_PARTY_DEPLOYS: undefined },
      { THIRD_PARTY_DEPLOYS: "true" },
      { GATEWAY_DEPLOYMENT_MODE: "self_hosted", THIRD_PARTY_DEPLOYS: "on" },
    ]) {
      Object.assign(hoisted.env, gate);
      const response = await register();
      expect(response.status, JSON.stringify(gate)).toBe(404);
      expect(await response.text()).toBe("control plane");
      expect((await deploy()).status).toBe(404);
    }
    expect(await row()).toBeUndefined();
    expect(script()).toBeUndefined();
  });

  it("refuses a member's deploy key, an access token and another organization", async () => {
    const member = await register(memberDeployKey);
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({ error: "DEPLOY_FORBIDDEN" });

    const access = await register(ownerAccessToken);
    expect(access.status).toBe(403);
    expect(await access.json()).toMatchObject({
      error: "DEPLOY_SCOPE_REQUIRED",
    });

    expect((await register("epat_unknown")).status).toBe(401);

    const elsewhere = await api("/api/v1/orgs/org-beta/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "todo" }),
    });
    expect(elsewhere.status).toBe(404);
    expect(await row()).toBeUndefined();

    // A removed owner's key stops working at once.
    await db.delete(members).where(eq(members.userId, "user-alice"));
    clearOrgContextCacheForTests();
    expect((await register()).status).toBe(401);
  });

  it("refuses a key holding any scope beside deploy, however its row was written", async () => {
    // Keys aren't made so; a row written by hand (or by an older gateway) is.
    await db
      .update(userAccessTokens)
      .set({ scopes: JSON.stringify(["*", "deploy"]) })
      .where(eq(userAccessTokens.scopes, JSON.stringify(["deploy"])));
    for (const response of [
      await api("/api/v1/deploy-key"),
      await register(),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "DEPLOY_SCOPE_REQUIRED",
      });
    }
    expect(await row()).toBeUndefined();
  });

  it("refuses a bundle that drops a live Durable Object class before its migrations run", async () => {
    await register();
    expect(((await (await deploy()).json()) as any).job.status).toBe(
      "succeeded",
    );
    const serving = script()!;
    const withoutSync = { ...TODO, resources: { d1: ["DB"] } };
    const form = upload(builtWorker(withoutSync), withoutSync);
    form.set(
      "migration:0001_more.sql",
      new File(["CREATE TABLE more (id text PRIMARY KEY);"], "0001_more.sql"),
    );
    const response = await deploy(form);
    const { job } = (await response.json()) as { job: Record<string, any> };
    expect(job).toMatchObject({
      status: "failed",
      error: { code: "BUNDLE_REFUSED" },
    });
    expect(job["error"].message).toContain("UserSyncDO");

    // The schema is where the serving version left it.
    const database = [...account.databases.values()].find(
      (entry) => entry.name === "every-acme-todo",
    )!;
    expect(database.db.all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(
      database.db.all("SELECT name FROM sqlite_master WHERE name = 'more'"),
    ).toEqual([]);
    expect(script()).toBe(serving);
  });

  it("refuses a bundle with a binding outside the allowlist, before anything is created", async () => {
    expect((await register()).status).toBe(201);
    const databases = account.databases.size;
    for (const [name, binding] of [
      ["OTHER_APP", { type: "worker", worker: "every-beta-notes" }],
      ["CACHE", { type: "kv", id: "0123456789abcdef0123456789abcdef" }],
      ["NAMESPACE", { type: "dispatch-namespace", namespace: NAMESPACE }],
      [
        "THEIRS",
        {
          type: "durable-object",
          worker: "every-beta-notes",
          exportName: "NotesDO",
        },
      ],
      ["PG", { type: "hyperdrive", id: "abc" }],
      ["AI", { type: "ai" }],
    ] as const) {
      const worker = builtWorker();
      worker["env"][name] = binding;
      const response = await deploy(upload(worker));
      expect(response.status, name).toBe(422);
      const body = (await response.json()) as {
        error: string;
        message: string;
      };
      expect(body.error).toBe("BUNDLE_REFUSED");
      expect(body.message).toContain(name);
    }
    const crons = builtWorker();
    crons["triggers"] = [{ type: "scheduled", schedule: "0 6 * * *" }];
    expect((await deploy(upload(crons))).status).toBe(422);

    expect(script()).toBeUndefined();
    expect(account.databases.size).toBe(databases);
    expect(await db.select().from(deployJobs)).toEqual([]);
    expect((await row())?.status).toBe("pending");
  });

  it("refuses a manifest that declares inbound mail, before anything is registered", async () => {
    // The platform's zones aren't an organization's to route: a dispatch
    // app declares no email() handler, at registration or at upload.
    const inbox = { ...TODO, email: { inbound: true } };
    const registered = await api(`/api/v1/orgs/${acme}/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "todo", manifest: inbox }),
    });
    expect(registered.status).toBe(422);
    const body = (await registered.json()) as {
      error: string;
      message: string;
    };
    expect(body.error).toBe("BUNDLE_REFUSED");
    expect(body.message).toContain("inbound mail (email.inbound)");
    expect(await row()).toBeUndefined();
    expect(await db.select().from(deployJobs)).toEqual([]);

    expect((await register()).status).toBe(201);
    const upload_ = await deploy(upload(builtWorker(), inbox));
    expect(upload_.status).toBe(422);
    expect(await upload_.json()).toMatchObject({ error: "BUNDLE_REFUSED" });
    expect(script()).toBeUndefined();
    expect((await row())?.status).toBe("pending");
  });

  it("deletes the Worker and fails the job when the bindings read back differ", async () => {
    await register();
    tamper = async (url, response) => {
      if (!url.pathname.endsWith("/bindings")) return response;
      const body = (await response.json()) as {
        result: Array<Record<string, unknown>>;
      };
      body.result = body.result.map((binding) =>
        binding["name"] === "EVERY_APP_GATEWAY"
          ? {
              ...binding,
              props: {
                ...(binding["props"] as object),
                organizationId: "org-beta",
              },
            }
          : binding,
      );
      return Response.json(body);
    };
    const response = await deploy();
    expect(((await response.json()) as any).job).toMatchObject({
      status: "failed",
      error: { code: "BINDINGS_MISMATCH" },
    });
    expect(script()).toBeUndefined();
    expect((await row())?.status).toBe("pending");
  });

  it("finishes a database a failed create left claimed, whether or not Cloudflare made it", async () => {
    await register();
    for (const made of [true, false]) {
      // The create's answer is lost: Cloudflare made the database (or not).
      tamper = async (url, response) => {
        if (!url.pathname.endsWith("/d1/database") || url.search) {
          return response;
        }
        if (!made) {
          for (const [id, entry] of account.databases) {
            if (entry.name === "every-acme-todo") account.databases.delete(id);
          }
        }
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "internal" }] },
          { status: 500 },
        );
      };
      const failed = await deploy();
      expect(((await failed.json()) as any).job, String(made)).toMatchObject({
        status: "failed",
        error: { code: "DEPLOY_FAILED" },
      });
      expect(script()).toBeUndefined();

      tamper = null;
      const again = await deploy();
      expect(((await again.json()) as any).job, String(made)).toMatchObject({
        status: "succeeded",
      });
      const named = [...account.databases].filter(
        ([, entry]) => entry.name === "every-acme-todo",
      );
      expect(named).toHaveLength(1);
      expect(script()!.bindings).toContainEqual({
        type: "d1",
        name: "DB",
        id: named[0]![0],
      });
      // The next run starts over: no database, no ledger, no Worker.
      account.databases.delete(named[0]![0]);
      account.dispatchNamespaces.get(NAMESPACE)!.scripts.clear();
      await db.run(sql`DELETE FROM _everyapp_app_resources`);
    }
  });

  it("refuses a database with the app's name that no deploy of it created", async () => {
    await register();
    await createCloudflareRest({
      apiToken: TOKEN,
      accountId: ACCOUNT_ID,
      fetch: account.api.fetch,
    }).d1.create("every-acme-todo");
    const response = await deploy();
    expect(((await response.json()) as any).job).toMatchObject({
      status: "failed",
      error: { code: "RESOURCE_NAME_TAKEN" },
    });
    expect(script()).toBeUndefined();
  });

  it("refuses a stamp below the protocol floor, before anything is registered", async () => {
    const form = upload();
    form.set(
      "stamp",
      JSON.stringify({ protocol: 0, sdkVersion: "0.1.0", cliVersion: "0.1.0" }),
    );
    const response = await deploy(form);
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ error: "PROTOCOL_TOO_OLD" });
    expect(await row()).toBeUndefined();
  });

  it("refuses a key bound to another app", async () => {
    await register();
    const notes = await api(`/api/v1/orgs/${acme}/apps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: "notes", manifest: { id: "notes" } }),
    });
    const notesRowId = (
      await db.select().from(apps).where(eq(apps.appSlug, "notes"))
    )[0]!.id;
    expect(notes.status).toBe(201);
    const { plaintext } = await UserPatService.create({
      userId: "user-alice",
      organizationId: acme,
      name: "notes ci",
      scopes: ["deploy"],
      appRowId: notesRowId,
    });
    const response = await deploy(upload(), plaintext);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "DEPLOY_KEY_APP_MISMATCH",
    });
    expect(script()).toBeUndefined();
  });

  it("runs one deploy of an app at a time, until a running one is past its deadline", async () => {
    await register();
    const appRowId = (await row())!.id;
    await db.insert(deployJobs).values({
      id: "job-running",
      organizationId: acme,
      appRowId,
      status: "running",
      createdAt: new Date(),
    });
    const before = await row();
    const busy = await deploy(
      upload(builtWorker(), { ...TODO, name: "Todos, renamed" }),
    );
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "DEPLOY_IN_PROGRESS" });
    expect(script()).toBeUndefined();
    // Refused before the row changes: not even its name or updatedAt.
    expect(await row()).toEqual(before);

    // The isolate that ran it is long gone: the job reads as abandoned and
    // the app deploys again.
    await db
      .update(deployJobs)
      .set({ createdAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(deployJobs.id, "job-running"));
    const polled = await api(`/api/v1/orgs/${acme}/deploys/job-running`);
    expect(((await polled.json()) as any).job).toMatchObject({
      status: "failed",
      error: { code: "DEPLOY_ABANDONED" },
    });
    expect(((await (await deploy()).json()) as any).job).toMatchObject({
      status: "succeeded",
    });
  });

  it("answers with the job when its outcome can't be recorded", async () => {
    await register();
    const finish = vi
      .spyOn(DeployJobRepository, "finish")
      .mockRejectedValueOnce(new Error("D1 is unavailable"));
    const response = await deploy();
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: Record<string, any> };
    // Uploaded, but unrecorded: it reads abandoned at its deadline.
    expect(job).toMatchObject({ status: "running", error: null });
    expect(script()).toBeDefined();
    expect(console.error).toHaveBeenCalledWith(
      "deploy job outcome not recorded:",
      expect.objectContaining({ message: "D1 is unavailable" }),
    );
    finish.mockRestore();
  });

  it("fails the job and logs once when registering a deploy throws an error the deployer didn't name", async () => {
    await register();
    // The registry write, after the job has started, fails as D1 might.
    await db.run(
      sql`CREATE TRIGGER apps_unavailable BEFORE UPDATE ON apps BEGIN SELECT RAISE(ABORT, 'D1 is unavailable'); END`,
    );
    vi.mocked(console.error).mockClear();
    const response = await deploy();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "The deploy API failed.",
    });
    const jobs = await db.select().from(deployJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("failed");
    expect(JSON.parse(jobs[0]!.error!)).toMatchObject({
      code: "DEPLOY_FAILED",
    });
    expect(script()).toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "deploy API error:",
      expect.any(Error),
    );
  });

  it("refuses a third-party domain on, under or above the gateway's own", async () => {
    hoisted.env["APP_BASE_DOMAIN"] = "app.everyapp.com";
    for (const domain of [
      "app.everyapp.com",
      "APP.everyapp.com.",
      "acme.app.everyapp.com",
      "everyapp.com",
    ]) {
      hoisted.env["THIRD_PARTY_DOMAIN"] = domain;
      const response = await register();
      expect(response.status, domain).toBe(503);
      expect(await response.json()).toMatchObject({
        error: "DEPLOYER_NOT_CONFIGURED",
      });
    }
    expect(await row()).toBeUndefined();

    hoisted.env["THIRD_PARTY_DOMAIN"] = "everyapp.dev";
    expect((await register()).status).toBe(201);
    hoisted.env["THIRD_PARTY_DOMAIN"] = "everyapp.com";
    const response = await deploy();
    expect(response.status).toBe(503);
    expect(await db.select().from(deployJobs)).toMatchObject([
      { status: "failed" },
    ]);
    expect(script()).toBeUndefined();
  });

  it("deploys without a third-party domain, with no hostname to open it on", async () => {
    delete hoisted.env["THIRD_PARTY_DOMAIN"];
    const registered = await register();
    expect(((await registered.json()) as any).app).toMatchObject({
      hostname: null,
      url: null,
    });
    const response = await deploy();
    expect(((await response.json()) as any).job).toMatchObject({
      status: "succeeded",
      app: { status: "binding", hostname: null, url: null },
    });
    expect(await row()).toMatchObject({
      tier: "dispatch",
      hostname: null,
      status: "binding",
    });
    expect(script()).toBeDefined();
  });

  it.each([
    ["the gateway's own site", "example.com"],
    ["a domain under the gateway's host", "apps.gateway.example.com"],
    ["no DNS name", "not a domain"],
  ])(
    "names no hostname on a third-party domain that is %s",
    async (_, domain) => {
      hoisted.env["THIRD_PARTY_DOMAIN"] = domain;
      const registered = await register();
      expect(((await registered.json()) as any).app).toMatchObject({
        hostname: null,
        url: null,
      });
    },
  );
});
