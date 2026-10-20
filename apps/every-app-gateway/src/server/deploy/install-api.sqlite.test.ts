/**
 * Install from GitHub end to end, in process: the admin routes
 * (src/routes/api/admin/) on SQLite, a GitHub that serves an app release
 * packed in the test (src/test/app-release.ts), and the CLI's fake
 * Cloudflare account behind the deployer's REST calls, as in
 * deploy-api.sqlite.test.ts.
 *
 * An admin installs a third-party app from its repository's latest
 * release: the row is written on the dispatch tier with the release as the
 * job's source, and what reaches the dispatch namespace is what a
 * multipart deploy of the same bundle uploads. A self-hosted gateway, a
 * gateway behind the launch gate, a member, a bad URL, a repository with
 * no release and a tampered release are refused before anything is
 * registered.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/sqlite-db";

const hoisted = vi.hoisted(() => ({
  testDb: { current: null as TestDb | null },
  env: {} as Record<string, unknown>,
  pending: [] as Promise<unknown>[],
  getSession: null as unknown as (input: {
    headers: Headers;
  }) => Promise<unknown>,
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
// Sessions as Better Auth would resolve them: the cookie names the user.
vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: (input: { headers: Headers }) => hoisted.getSession(input),
    },
  },
}));
vi.mock("@tanstack/react-start/server-entry", () => ({
  default: {
    fetch: async () => new Response("control plane", { status: 404 }),
  },
}));

import { generateKeyPairSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { createCloudflareRest } from "@every-app/cf-rest";
import { everyAppWorker } from "@every-app/sdk/cloudflare";
import { apps, deployJobs, members, organizations, users } from "@/db/schema";
import { Route as InstallRoute } from "@/routes/api/admin/apps/install";
import { Route as JobRoute } from "@/routes/api/admin/deploys/$id";
import server, { clearHostnameCacheForTests } from "@/server";
import { clearOrgContextCacheForTests } from "@/server/organization/orgContext";
import { UserPatService } from "@/server/services/UserPatService";
import { packRelease, releaseFiles } from "@/test/app-release";
import { createTestDb } from "@/test/sqlite-db";

const GATEWAY = "https://gateway.example.com";
const NAMESPACE = "every-app-apps";
const TOKEN = "fake-cloudflare-api-token";
const ACCOUNT_ID = "0123456789abcdef0123456789abcd01";
const REPO = "https://github.com/acme/todo";

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
  ): unknown;
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
let db: TestDb;
let keys: { privateKey: string; publicKey: string };
const acme = "org-acme";
/** What GitHub serves: a repository's latest release, or none. */
const releases = new Map<string, Uint8Array>();
const githubRequests: string[] = [];

beforeAll(() => {
  keys = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }) as unknown as { privateKey: string; publicKey: string };
});

/** The app's tenant-neutral Build Output config, as a release carries it. */
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

const MODULES = {
  "index.js": "export default {}",
  "index.js.map": "{}",
  ".vite/manifest.json": "{}",
};
const MIGRATION =
  "CREATE TABLE todos (id text PRIMARY KEY);\n--> statement-breakpoint\nCREATE INDEX todos_id ON todos (id);";

function files(
  worker = builtWorker(),
  manifest: Record<string, unknown> & { id: string } = TODO,
) {
  return releaseFiles({
    manifest,
    worker,
    modules: MODULES,
    assets: { "favicon.ico": new Uint8Array([1, 2, 3]) },
    migrations: { "0000_init.sql": MIGRATION, "meta/_journal.json": "{}" },
  });
}

/** The same bundle as `everyapp deploy --gateway` uploads it. */
function upload(worker: Record<string, unknown>): FormData {
  const form = new FormData();
  form.set("manifest", JSON.stringify(TODO));
  form.set(
    "stamp",
    JSON.stringify({ protocol: 1, sdkVersion: "0.3.0", cliVersion: "0.3.0" }),
  );
  form.set("worker", JSON.stringify(worker));
  form.set("module:index.js", new File([MODULES["index.js"]], "index.js"));
  form.set("module:index.js.map", new File(["{}"], "index.js.map"));
  form.set("module:.vite/manifest.json", new File(["{}"], "manifest.json"));
  form.set("asset:/favicon.ico", new File([new Uint8Array([1, 2, 3])], "f"));
  form.set("migration:0000_init.sql", new File([MIGRATION], "0000_init.sql"));
  return form;
}

type Handler = (ctx: {
  request: Request;
  params?: Record<string, string>;
}) => Promise<Response>;
const handlers = (route: unknown) =>
  (route as { options: { server: { handlers: Record<string, Handler> } } })
    .options.server.handlers;

function adminRequest(
  pathname: string,
  user: string | null,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (user) headers.set("cookie", `test-session=${user}`);
  return new Request(`${GATEWAY}${pathname}`, { ...init, headers });
}

async function install(
  repoUrl: unknown = REPO,
  user: string | null = "user-carol",
): Promise<Response> {
  const response = await handlers(InstallRoute)["POST"]!({
    request: adminRequest("/api/admin/apps/install", user, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl }),
    }),
  });
  await Promise.all(hoisted.pending.splice(0));
  return response;
}

function availability(user = "user-carol"): Promise<Response> {
  return handlers(InstallRoute)["GET"]!({
    request: adminRequest("/api/admin/apps/install", user),
  });
}

function poll(id: string, user = "user-carol"): Promise<Response> {
  return handlers(JobRoute)["GET"]!({
    request: adminRequest(`/api/admin/deploys/${id}`, user),
    params: { id },
  });
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

async function expectNothingRegistered() {
  expect(await row()).toBeUndefined();
  expect(await db.select().from(deployJobs)).toEqual([]);
  expect(script()).toBeUndefined();
}

beforeEach(async () => {
  for (const key of Object.keys(hoisted.env)) delete hoisted.env[key];
  hoisted.pending.length = 0;
  releases.clear();
  githubRequests.length = 0;
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
  // GitHub as it serves a release: the latest download redirects to the
  // tag's, which redirects to storage.
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "github.com") {
        githubRequests.push(url.href);
        const [, owner, repo, , kind, tag] = url.pathname.split("/");
        const repoUrl = `https://github.com/${owner}/${repo}`;
        if (!releases.has(repoUrl)) {
          return new Response("Not Found", { status: 404 });
        }
        const location =
          kind === "latest"
            ? `${repoUrl}/releases/download/v1.2.3/everyapp-release.tar.gz`
            : `https://release-assets.example/${tag}?repo=${encodeURIComponent(repoUrl)}`;
        return new Response(null, { status: 302, headers: { location } });
      }
      if (url.hostname === "release-assets.example") {
        const release = releases.get(url.searchParams.get("repo")!)!;
        return new Response(release as Uint8Array<ArrayBuffer>);
      }
      return account.api.fetch(input, init);
    },
  );

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
    DISPATCHER: account.dispatcher(NAMESPACE, () => new Response("todo app")),
  });

  db = await createTestDb();
  hoisted.testDb.current = db;
  hoisted.getSession = async ({ headers }) => {
    const userId = /test-session=([^;]+)/.exec(
      headers.get("cookie") ?? "",
    )?.[1];
    if (!userId) return null;
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    return user
      ? { user, session: { activeOrganizationId: acme, userId } }
      : null;
  };
  await db
    .insert(organizations)
    .values({ id: acme, name: "Acme", slug: "acme", createdAt: new Date() });
  await addMember("alice", "owner");
  await addMember("bob", "member");
  await addMember("carol", "admin");
  releases.set(REPO, packRelease(files()));
});

describe("install from GitHub (SQLite, fake GitHub and Cloudflare)", () => {
  it("installs an app from its repository's latest release", async () => {
    expect(await (await availability()).json()).toEqual({ available: true });

    const response = await install(`${REPO}.git`);
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: Record<string, any> };
    expect(job).toMatchObject({
      status: "succeeded",
      error: null,
      source: {
        repoUrl: REPO,
        tag: "v1.2.3",
        version: "1.2.3",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
      },
      app: {
        id: "todo",
        status: "binding",
        url: "https://todo-acme.everyapp.dev",
      },
    });
    expect(githubRequests).toEqual([
      `${REPO}/releases/latest/download/everyapp-release.tar.gz`,
      `${REPO}/releases/download/v1.2.3/everyapp-release.tar.gz`,
    ]);
    expect(await row()).toMatchObject({
      tier: "dispatch",
      scope: "org",
      hostname: "todo-acme.everyapp.dev",
      workerName: "every-acme-todo",
      status: "binding",
      deployedByActor: "carol@example.com",
    });
    const [stored] = await db.select().from(deployJobs);
    expect(JSON.parse(stored!.source!)).toEqual(job["source"]);

    const polled = await poll(job["id"]);
    expect(((await polled.json()) as any).job).toMatchObject({
      status: "succeeded",
      source: { tag: "v1.2.3" },
    });
    expect((await poll("no-such-job")).status).toBe(404);

    // Its own database, migrated; every binding the deployer's.
    const database = [...account.databases.values()].find(
      (entry) => entry.name === "every-acme-todo",
    )!;
    expect(database.db.all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(JSON.stringify(script()!.bindings)).not.toContain("sentinel");
    expect(script()!.bindings).toContainEqual({
      type: "plain_text",
      name: "GATEWAY_URL",
      text: GATEWAY,
    });
    expect(Object.keys(script()!.modules).sort()).toEqual([
      "index.js",
      "index.js.map",
    ]);
  });

  it("uploads what a multipart deploy of the same bundle uploads", async () => {
    const worker = builtWorker();
    releases.set(REPO, packRelease(files(worker)));
    expect(((await (await install()).json()) as any).job.status).toBe(
      "succeeded",
    );
    const installed = structuredClone(script()!);

    const { plaintext } = await UserPatService.create({
      userId: "user-alice",
      organizationId: acme,
      name: "ci",
      scopes: ["deploy"],
    });
    const deployed = await server.fetch(
      new Request(`${GATEWAY}/api/v1/orgs/${acme}/apps/todo/deploys`, {
        method: "POST",
        headers: {
          host: "gateway.example.com",
          authorization: `Bearer ${plaintext}`,
        },
        body: upload(worker),
      }),
    );
    await Promise.all(hoisted.pending.splice(0));
    expect(((await deployed.json()) as any).job.status).toBe("succeeded");
    const uploaded = script()!;
    expect(uploaded.bindings).toEqual(installed.bindings);
    expect(uploaded.modules).toEqual(installed.modules);
    expect(uploaded.tags).toEqual(installed.tags);
    expect(uploaded.limits).toEqual(installed.limits);
  });

  it("isn't available on a self-hosted gateway or behind the launch gate", async () => {
    for (const gate of [
      { THIRD_PARTY_DEPLOYS: undefined },
      { THIRD_PARTY_DEPLOYS: "true" },
      { GATEWAY_DEPLOYMENT_MODE: "self_hosted", THIRD_PARTY_DEPLOYS: "on" },
    ]) {
      Object.assign(hoisted.env, gate);
      const response = await install();
      expect(response.status, JSON.stringify(gate)).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "APP_INSTALL_NOT_AVAILABLE",
      });
      expect(await (await availability()).json()).toEqual({
        available: false,
      });
    }
    expect(githubRequests).toEqual([]);
    await expectNothingRegistered();
  });

  it("refuses a member, a signed-out caller and a suspended organization", async () => {
    const member = await install(REPO, "user-bob");
    expect(member.status).toBe(403);
    expect(await member.json()).toMatchObject({
      error: "APP_INSTALL_FORBIDDEN",
    });
    expect((await availability("user-bob")).status).toBe(403);
    expect((await install(REPO, null)).status).toBe(401);

    await db
      .update(organizations)
      .set({ status: "suspended" })
      .where(eq(organizations.id, acme));
    clearOrgContextCacheForTests();
    const suspended = await install();
    expect(suspended.status).toBe(403);
    expect(await suspended.json()).toMatchObject({
      error: "ORGANIZATION_SUSPENDED",
    });
    expect(githubRequests).toEqual([]);
    await expectNothingRegistered();
  });

  it("refuses a URL that isn't a GitHub repository", async () => {
    for (const repoUrl of [
      "https://gitlab.com/acme/todo",
      "https://github.com/acme",
      "https://github.com.evil.example/acme/todo",
      null,
    ]) {
      const response = await install(repoUrl);
      expect(response.status, String(repoUrl)).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "INVALID_REPO_URL",
      });
    }
    expect(githubRequests).toEqual([]);
    await expectNothingRegistered();
  });

  it("says how to deploy a repository that publishes no release", async () => {
    const response = await install("https://github.com/acme/no-release");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("NO_RELEASE");
    expect(body.message).toContain("Clone it and run `pnpm everyapp deploy`");
    await expectNothingRegistered();
  });

  it("refuses a tampered release before anything is registered", async () => {
    const tampered = files();
    tampered.set(
      ".cloudflare/output/v0/workers/default/bundle/index.js",
      new TextEncoder().encode("export default { fetch() { return steal() } }"),
    );
    releases.set(REPO, packRelease(tampered));
    const response = await install();
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "RELEASE_CORRUPT" });
    await expectNothingRegistered();
  });

  it("refuses a release the hosted policy refuses, before registering it", async () => {
    const worker = builtWorker();
    worker["env"]["CACHE"] = {
      type: "kv",
      id: "0123456789abcdef0123456789abcdef",
    };
    releases.set(REPO, packRelease(files(worker)));
    const response = await install();
    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("BUNDLE_REFUSED");
    expect(body.message).toContain("CACHE");
    await expectNothingRegistered();

    // A release whose manifest declares inbound mail: a third-party app
    // receives none, and the refusal comes before its row is written.
    releases.set(
      REPO,
      packRelease(files(builtWorker(), { ...TODO, email: { inbound: true } })),
    );
    const inbound = await install();
    expect(inbound.status).toBe(422);
    const refused = (await inbound.json()) as {
      error: string;
      message: string;
    };
    expect(refused.error).toBe("BUNDLE_REFUSED");
    expect(refused.message).toContain("inbound mail (email.inbound)");
    await expectNothingRegistered();
  });

  it("runs one deploy of an app at a time", async () => {
    expect(((await (await install()).json()) as any).job.status).toBe(
      "succeeded",
    );
    await db.insert(deployJobs).values({
      id: "job-running",
      organizationId: acme,
      appRowId: (await row())!.id,
      status: "running",
      createdAt: new Date(),
    });
    const busy = await install();
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "DEPLOY_IN_PROGRESS" });
  });
});
