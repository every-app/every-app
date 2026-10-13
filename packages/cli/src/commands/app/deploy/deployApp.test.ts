/**
 * `everyapp app deploy` and `app delete` end to end: a fake Cloudflare
 * account behind FakeCf (real SQLite D1, Build Outputs validated with cf's
 * schema, the app's Worker built by the SDK's real everyAppWorker()) and the
 * gateway's deploy API over the same registry database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionSummary, removeApp } from "@/commands/app/delete";
import { queryAppD1 } from "@/commands/app/d1";
import { readOwnedResources, recordOwnedResource } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { handleInterrupt, resetInterruptsForTests } from "@/lib/interrupt";
import { acquireLease, readLease } from "@/lib/gateway/lease";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { FakeGateway, GATEWAY_URL } from "@/test/fakeGateway";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
};

let account: FakeCloudflare;
let gateway: FakeGateway;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;
const otherDirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = {
  readStatus: () => account.gatewayStatus(),
  sleep: async () => undefined,
  verifyTimeoutMs: 0,
  leaseWaitMs: 0,
};

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  account = new FakeCloudflare();
  gateway = new FakeGateway(account);

  // A gateway this CLI deployed, installed before per-app domains: apps
  // reach it through its wildcard route, at <app>-<org>.example.com. (The
  // per-app Custom Domains of new installs are below.)
  release = await openRelease(await buildGatewayRelease());
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    routing: "wildcard-route",
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    lookupCaa: account.lookupCaa,
    ...seams,
  });
  gateway.seedOrganization();

  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY, title text);",
  );
  fs.writeFileSync(
    path.join(appDir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  account.apps.set(appDir, TODO);
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
  for (const dir of otherDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function deploy(
  manifest: EveryAppCliManifest = TODO,
  options: Partial<Parameters<typeof deployApp>[0]> = {},
) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    gatewayUrl: GATEWAY_URL,
    out: out(),
    createCf: () => account.cf,
    client: gateway.client,
    sleep: async () => undefined,
    checkDns: async () => true,
    installDeps: async () => undefined,
    reconcile: seams,
    ...options,
  });
}

const gatewayVersions = () =>
  account.workers.get("every-app-gateway")!.versions.length;

/** Another app's project directory. */
function deployOther(manifest: EveryAppCliManifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  otherDirs.push(dir);
  fs.writeFileSync(path.join(dir, "cloudflare.config.ts"), "everyAppWorker\n");
  account.apps.set(dir, manifest);
  return deployApp({
    cwd: dir,
    manifest,
    gatewayUrl: GATEWAY_URL,
    out: out(),
    createCf: () => account.cf,
    client: gateway.client,
    sleep: async () => undefined,
    checkDns: async () => true,
    installDeps: async () => undefined,
    reconcile: seams,
  });
}

const registry = () =>
  cfD1Database(account.cf, [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0]);

const databaseId = (name: string) =>
  [...account.databases].find(([, db]) => db.name === name)?.[0];

describe("app deploy", () => {
  it("takes a new app from registration to a live, bound Worker", async () => {
    const result = await deploy();

    expect(result).toMatchObject({
      liveUrl: "https://todo-acme.example.com",
      workerName: "every-acme-todo",
    });
    // Its own resources, under the gateway's org-scoped names.
    const appDb = account.database("every-acme-todo");
    expect(appDb.all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(account.namespaceId("every-acme-todo")).toBeTruthy();

    // The upload: the Worker everyAppWorker() builds, with the deploy's ids,
    // its source maps listed, and the secrets in the same version.
    const upload = account.deploys.find((d) => d.workerName === "every-acme-todo")!;
    expect(upload.config["env"]).toMatchObject({
      DB: { type: "d1", name: "every-acme-todo" },
      EVERYAPP_IDENTITY_ISSUER: { type: "text", value: GATEWAY_URL },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: { organizationId: "org-1", appId: "todo", workerName: "every-acme-todo" },
      },
    });
    expect(upload.config["env"].EVERYAPP_DEV).toBeUndefined();
    expect(upload.config["manifest"].modules).toEqual({
      "assets/x.js.map": { type: "sourcemap" },
    });
    expect(upload.secrets).toEqual({
      GATEWAY_URL,
      EVERY_APP_ORG_ID: "org-1",
    });
    // The deploy inputs exist only while cf builds.
    expect(fs.existsSync(path.join(appDir, ".everyapp", "deploy.json"))).toBe(false);

    // The gateway now binds it, and the app is live.
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(gateway.app("todo")).toMatchObject({ status: "active" });
    // Migrations ran before the upload, the gateway was reconciled after it.
    const steps = events
      .filter((event) => event["type"] === "step" && event["status"] !== "start")
      .map((event) => event["step"]);
    expect(steps).toEqual([
      "app.register",
      "app.migrations",
      "app.upload",
      "gateway.deploy",
      "gateway.verify",
      "app.tools",
    ]);
    // Once it is live, the gateway snapshots its agent tools.
    expect(gateway.toolSyncs).toEqual(["todo"]);
    const leases = account.database("every-app-gateway").all(
      "SELECT * FROM _everyapp_deploy_lease",
    );
    expect(leases).toEqual([]);
  });

  it("redeploys an app's code without touching the gateway", async () => {
    await deploy();
    const before = gatewayVersions();

    await deploy({ ...TODO, description: "v2" });

    expect(gatewayVersions()).toBe(before);
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(2);
    expect(gateway.app("todo")).toMatchObject({ status: "active" });
    // New code may define other tools: every deploy syncs them.
    expect(gateway.toolSyncs).toEqual(["todo", "todo"]);
  });

  it("keeps a legacy app on its every-<appId> Worker and data", async () => {
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy', 'org-1', 'todo', 'Todos', 'Todos', 'todo-acme.example.com', 'every-todo', '{"id":"todo"}', 'active', 1);
    `);
    const legacyDb = account.createDatabase("every-todo").db;
    legacyDb.sqlite.exec(
      "CREATE TABLE todos (id text PRIMARY KEY, title text); CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text, created_at numeric); INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('h', 1000);",
    );

    const result = await deploy();

    expect(result.workerName).toBe("every-todo");
    // drizzle-kit applied 0000 before: recorded, not run again.
    expect(legacyDb.all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(account.gatewayBindings()).toEqual(["every-todo"]);
    // From now on they are recorded as the app's own.
    await expect(readOwnedResources(registry(), "every-todo")).resolves.toEqual([
      { kind: "d1", binding: "DB", name: "every-todo", resourceId: databaseId("every-todo"), versionId: null },
      { kind: "kv", binding: "KV", name: "every-todo", resourceId: account.namespaceId("every-todo"), versionId: null },
      {
        kind: "worker",
        binding: "",
        name: "every-todo",
        resourceId: "every-todo",
        versionId: result.versionId,
      },
    ]);
  });

  it("never adopts a database a legacy app's new binding would share with another app", async () => {
    // Legacy apps `todo` and `todo-archive`: `todo` adding ARCHIVE would get
    // every-todo-archive, which is `todo-archive`'s database.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy', 'org-1', 'todo', 'Todos', 'Todos', 'todo-acme.example.com', 'every-todo', '${JSON.stringify(TODO)}', 'active', 1);
    `);
    account.createDatabase("every-todo");
    const theirs = account.createDatabase("every-todo-archive");

    await expect(
      deploy({ ...TODO, resources: { ...TODO.resources, d1: ["DB", "ARCHIVE"] } }),
    ).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    expect(theirs.db.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);
  });

  it("never takes another legacy app's database, even for a binding it declared", async () => {
    // Legacy apps `todo`, which declared ARCHIVE, and `todo-archive`: the
    // wrangler-era CLI named both `todo`'s ARCHIVE and `todo-archive`'s DB
    // every-todo-archive.
    const withArchive = { ...TODO, resources: { ...TODO.resources, d1: ["DB", "ARCHIVE"] } };
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy', 'org-1', 'todo', 'Todos', 'Todos', 'todo-acme.example.com', 'every-todo', '${JSON.stringify(withArchive)}', 'active', 1),
        ('legacy-archive', 'org-1', 'todo-archive', 'Archive', 'Archive', 'todo-archive-acme.example.com', 'every-todo-archive', '{"id":"todo-archive"}', 'active', 1);
    `);
    account.createDatabase("every-todo");
    const theirs = account.createDatabase("every-todo-archive");

    await expect(deploy(withArchive)).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining("is app todo-archive's"),
    });
    expect(theirs.db.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);
    expect(
      (await readOwnedResources(registry(), "every-todo")).map((resource) => resource.name),
    ).not.toContain("every-todo-archive");

    // Nor is it created while that app has none.
    account.databases.delete(theirs.uuid);
    await expect(deploy(withArchive)).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    expect(databaseId("every-todo-archive")).toBeUndefined();
  });

  it("refuses someone else's database on every attempt, not just the first", async () => {
    const foreign = account.createDatabase("every-acme-todo");
    foreign.db.sqlite.exec("CREATE TABLE theirs (v TEXT); INSERT INTO theirs VALUES ('not yours');");

    await expect(deploy()).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    // The failed attempt left the app registered...
    expect(gateway.app("todo")).toMatchObject({ status: "pending" });
    // ...and running the deploy again still refuses.
    await expect(deploy()).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });

    expect(foreign.db.all("SELECT v FROM theirs")).toEqual([{ v: "not yours" }]);
    expect(
      foreign.db.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.has("every-acme-todo")).toBe(false);
    expect(account.gatewayBindings()).toEqual([]);
  });

  it("refuses someone else's Worker on every attempt", async () => {
    account.workers.set("every-acme-todo", {
      versions: ["theirs-1"],
      config: { name: "every-acme-todo", env: {} },
      secrets: {},
    });

    await expect(deploy()).rejects.toMatchObject({ code: "WORKER_NAME_TAKEN" });
    await expect(deploy()).rejects.toMatchObject({ code: "WORKER_NAME_TAKEN" });

    expect(account.workers.get("every-acme-todo")!.versions).toEqual(["theirs-1"]);
    expect([...account.databases.values()].map((db) => db.name)).toEqual([
      "every-app-gateway",
    ]);
  });

  it("finds a database it created but couldn't record", async () => {
    // The create went through; recording its id didn't.
    await recordOwnedResource(registry(), "every-acme-todo", {
      kind: "d1",
      binding: "DB",
      name: "every-acme-todo",
      resourceId: null,
    });
    const created = account.createDatabase("every-acme-todo");

    await deploy();

    const upload = account.deploys.find((d) => d.workerName === "every-acme-todo")!;
    expect(upload.config["env"].DB.id).toBe(created.uuid);
  });

  it("names app notes' ARCHIVE database so app notes-archive's is never its own", async () => {
    await deployOther({ id: "notes-archive", resources: { d1: ["DB"] } });
    account
      .database("every-acme-notes-archive")
      .sqlite.exec("CREATE TABLE secrets (v TEXT); INSERT INTO secrets VALUES ('notes-archive data');");
    const notes: EveryAppCliManifest = { id: "notes", resources: { d1: ["DB"] } };
    await deployOther(notes);

    // A normal redeploy that adds a binding.
    await deployOther({ ...notes, resources: { d1: ["DB", "ARCHIVE"] } });

    const archive = account.workers.get("every-acme-notes")!.config["env"].ARCHIVE;
    expect(archive).toMatchObject({ name: "every-acme-notes--archive" });
    expect(archive.id).not.toBe(databaseId("every-acme-notes-archive"));

    await removeApp({
      appId: "notes",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });
    expect([...account.databases.values()].map((db) => db.name).sort()).toEqual([
      "every-acme-notes-archive",
      "every-app-gateway",
    ]);
    expect(account.database("every-acme-notes-archive").all("SELECT v FROM secrets")).toEqual([
      { v: "notes-archive data" },
    ]);
  });

  it("builds and checks the Worker before it migrates the database", async () => {
    account.editBuild = (config) => {
      config["env"].EXTRA = { type: "hyperdrive", id: "h-1" };
    };

    await expect(deploy()).rejects.toMatchObject({ code: "APP_POLICY" });
    expect(
      account
        .database("every-acme-todo")
        .all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.has("every-acme-todo")).toBe(false);
  });

  it("stops unattended over an app Worker it didn't record deploying, before migrating", async () => {
    // A legacy app the wrangler-era CLI deployed: Worker and data exist.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy', 'org-1', 'todo', 'Todos', 'Todos', 'todo-acme.example.com', 'every-todo', '${JSON.stringify(TODO)}', 'active', 1);
    `);
    const legacyDb = account.createDatabase("every-todo").db;
    account.workers.set("every-todo", {
      versions: ["wrangler-1"],
      config: { name: "every-todo", env: {} },
      secrets: { GATEWAY_URL: GATEWAY_URL, EVERY_APP_ORG_ID: "org-1" },
    });

    await expect(deploy()).rejects.toMatchObject({ action: "rerun_interactive" });
    expect(
      legacyDb.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.get("every-todo")!.versions).toEqual(["wrangler-1"]);

    // At a terminal a person is asked first; once they say yes, the
    // recorded version lets the next unattended deploy go ahead.
    await expect(
      deploy(TODO, { interactive: true, confirm: async () => false }),
    ).rejects.toMatchObject({ code: "DEPLOY_CANCELLED" });
    expect(
      legacyDb.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    await deploy(TODO, { interactive: true, confirm: async () => true });
    await expect(deploy()).resolves.toMatchObject({ workerName: "every-todo" });
  });

  it("lets a retry go unattended after a deploy that uploaded but couldn't tell the gateway", async () => {
    await deploy();
    // The next deploy uploads, then the gateway can't be reached.
    const markDeployed = gateway.client.markDeployed;
    (gateway.client as any).markDeployed = async () => {
      throw new Error("fetch failed");
    };
    await expect(deploy({ ...TODO, description: "v2" })).rejects.toThrow("fetch failed");
    (gateway.client as any).markDeployed = markDeployed;

    // The upload was recorded on the spot, so this isn't a stranger's version.
    await expect(deploy({ ...TODO, description: "v2" })).resolves.toMatchObject({
      workerName: "every-acme-todo",
    });
  });

  it("records an upload cf finished when Ctrl+C stopped the deploy then", async () => {
    await deploy();
    let interrupted: Promise<void> | undefined;
    const exit = vi.fn();
    account.afterUpload = () => {
      account.afterUpload = null;
      // Ctrl+C as cf finishes the upload: cf is stopped before it exits.
      interrupted = handleInterrupt("SIGINT", { exit });
      return { exitCode: 130, stderr: "" };
    };
    await expect(deploy({ ...TODO, description: "v2" })).rejects.toThrow();
    await interrupted;
    expect(exit).toHaveBeenCalledWith(130);

    const uploaded = account.workers.get("every-acme-todo")!.versions.at(-1);
    const worker = (await readOwnedResources(registry(), "every-acme-todo")).find(
      (resource) => resource.kind === "worker",
    );
    expect(worker?.versionId).toBe(uploaded);
    // So the next unattended deploy knows that version was everyapp's.
    resetInterruptsForTests();
    await expect(deploy({ ...TODO, description: "v3" })).resolves.toMatchObject({
      workerName: "every-acme-todo",
    });
  });

  it("records an upload that went live though cf failed after it", async () => {
    await deploy();
    account.afterUpload = () => {
      account.afterUpload = null;
      return { exitCode: 1, stderr: "\n┌ Error\n│ A request to the Cloudflare API failed.\n└\n" };
    };
    await expect(deploy({ ...TODO, description: "v2" })).rejects.toThrow();

    const uploaded = account.workers.get("every-acme-todo")!.versions.at(-1);
    const worker = (await readOwnedResources(registry(), "every-acme-todo")).find(
      (resource) => resource.kind === "worker",
    );
    expect(worker?.versionId).toBe(uploaded);
    await expect(deploy({ ...TODO, description: "v3" })).resolves.toMatchObject({
      workerName: "every-acme-todo",
    });
  });

  it("takes over only the app's own lease with --break-lease", async () => {
    // A deploy of this app that died holding its lease, and a gateway
    // upgrade that is still running.
    await acquireLease({
      db: registry(),
      id: "app:every-acme-todo",
      purpose: "app.deploy",
      heartbeatMs: 0,
    });
    const upgrade = await acquireLease({
      db: registry(),
      id: "gateway",
      purpose: "gateway.upgrade",
      heartbeatMs: 0,
    });
    const asked: string[] = [];

    await expect(
      deploy(TODO, {
        breakLease: async (current) => (asked.push(current.purpose), true),
      }),
    ).rejects.toMatchObject({
      code: "LEASE_HELD",
      message: expect.stringContaining("everyapp gateway reconcile --break-lease"),
    });

    expect(asked).toEqual(["app.deploy"]);
    await expect(readLease(registry(), "gateway")).resolves.toMatchObject({
      holder: upgrade.holder,
    });
  });

  it("refuses to drop a Durable Object class without the flag", async () => {
    await deploy();
    const withoutSync: EveryAppCliManifest = {
      ...TODO,
      resources: { d1: ["DB"], kv: ["KV"] },
    };

    await expect(deploy(withoutSync)).rejects.toMatchObject({
      code: "DURABLE_OBJECT_REMOVED",
    });
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(1);

    await deploy(withoutSync, { allowDeleteDurableObjectData: true });
    expect(account.deploys.at(-1)!.config["exports"]).toEqual({
      UserSyncDO: { type: "durable-object", state: "deleted" },
    });
  });

  it("stops before uploading when the account has no workers.dev subdomain", async () => {
    account.failNextDeploy = `Register a workers.dev subdomain: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;

    await expect(deploy()).rejects.toMatchObject({
      action: "register_workers_subdomain",
    });
    // Registered and provisioned; the next run picks it up, with the same
    // database and namespace it created.
    expect(gateway.app("todo")).toMatchObject({ status: "pending" });
    const created = databaseId("every-acme-todo");
    await expect(deploy()).resolves.toMatchObject({ workerName: "every-acme-todo" });
    expect(
      account.deploys.find((d) => d.workerName === "every-acme-todo")!.config["env"].DB.id,
    ).toBe(created);
  });

  it("runs SQL against the app's production database", async () => {
    await deploy();
    account.database("every-acme-todo").sqlite.exec(
      "INSERT INTO todos (id, title) VALUES ('1', 'ship it')",
    );
    fs.writeFileSync(
      path.join(appDir, "everyapp.config.ts"),
      `export default ${JSON.stringify(TODO)};\n`,
    );

    await expect(
      queryAppD1({
        cwd: appDir,
        sql: "SELECT title FROM todos",
        local: false,
        client: gateway.client,
        createCf: () => account.cf,
      }),
    ).resolves.toEqual([[{ title: "ship it" }]]);
  });
});

describe("app deploy and delete with per-app Custom Domains", () => {
  const GW = "apps.example.com";
  const certificateChecks: string[] = [];
  const certificates = {
    isReady: async (url: string) => {
      certificateChecks.push(url);
      return true;
    },
    sleep: async () => undefined,
  };

  /** A new install: the gateway at apps.example.com in zone example.com. */
  beforeEach(async () => {
    certificateChecks.length = 0;
    account = new FakeCloudflare();
    gateway = new FakeGateway(account, GW);
    const resources = await ensureGatewayResources(account.cf);
    await applyGateway({
      cf: account.cf,
      out: out(),
      reason: "deploy",
      release,
      accountId: ACCOUNT_ID,
      gatewayHost: GW,
      zone: { id: "zone-1", name: "example.com" },
      routing: "custom-domains",
      appBaseDomain: GW,
      resources,
      db: cfD1Database(account.cf, resources.d1Id),
      interactive: false,
      cliVersion: "0.3.0",
      lookupCaa: account.lookupCaa,
      ...seams,
    });
    gateway.seedOrganization();
    account.apps.set(appDir, TODO);
    account.cf.calls.length = 0;
    events = [];
  });

  function deployHere(options: Partial<Parameters<typeof deployApp>[0]> = {}) {
    return deployApp({
      cwd: appDir,
      manifest: TODO,
      gatewayUrl: gateway.gatewayUrl,
      out: out(),
      createCf: () => account.cf,
      client: gateway.client,
      sleep: async () => undefined,
      // No wildcard record to look for on these installs.
      checkDns: async () => {
        throw new Error("checked for a wildcard DNS record");
      },
      installDeps: async () => undefined,
      reconcile: { ...seams, lookupCaa: account.lookupCaa },
      certificates,
      ...options,
    });
  }

  const cfCommands = () =>
    account.cf.calls.map((call) => call.args.slice(0, 3).join(" "));

  it("publishes a new app at <app>.<base> as its own Custom Domain, then waits for its certificate", async () => {
    const result = await deployHere();

    expect(result).toMatchObject({
      liveUrl: `https://todo.${GW}`,
      hostname: `todo.${GW}`,
      workerName: "every-acme-todo",
    });
    expect(account.gatewayDomains()).toEqual([GW, `todo.${GW}`]);
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(gateway.app("todo")).toMatchObject({ status: "active" });
    await expect(readInstall(registry())).resolves.toMatchObject({
      liveDomains: [GW, `todo.${GW}`],
    });
    // Checked before anything was created or uploaded.
    const commands = cfCommands();
    const checked = commands.indexOf("dns records list");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(commands.indexOf("d1 create --name"));
    expect(checked).toBeLessThan(commands.indexOf("build"));
    // Its certificate, once the gateway serves it.
    expect(certificateChecks).toEqual([`https://todo.${GW}/`]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "app.tls",
        message: `https://todo.${GW} has its certificate.`,
      }),
    );
  });

  it("redeploys an app's code without touching the gateway or its domains", async () => {
    await deployHere();
    const versions = gatewayVersions();
    account.cf.calls.length = 0;

    await deployHere();

    expect(gatewayVersions()).toBe(versions);
    expect(cfCommands()).not.toContain("dns records list");
    expect(certificateChecks).toHaveLength(1);
  });

  it("never redeploys the gateway for a hostname it doesn't publish, outside the base", async () => {
    // A registry row from before, at a host that isn't one label below the base.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT OR IGNORE INTO organization_keys (organization_id, org_key) VALUES ('org-1', 'acme');
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
        VALUES ('row-todo', 'org-1', 'todo', 'todo', 'todo', 'todo.example.com', 'every-acme-todo', '{}', 'pending', 0);
    `);
    await deployHere();
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(account.gatewayDomains()).toEqual([GW]);
    const versions = gatewayVersions();
    account.cf.calls.length = 0;
    events = [];

    await deployHere();

    // Bound already, and its host is never published: nothing to redeploy.
    expect(gatewayVersions()).toBe(versions);
    expect(cfCommands()).not.toContain("dns records list");
    expect(certificateChecks).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "APP_HOST_OUTSIDE_BASE",
        message: expect.stringContaining("todo.example.com isn't one label below apps.example.com"),
      }),
    );

    // Deleting it leaves a certificate for that host alone: not the gateway's.
    account.certificatePacks.push({ id: "pack-site", zoneId: "zone-1", hosts: ["todo.example.com"] });
    await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: { ...seams, lookupCaa: account.lookupCaa },
    });
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.certificatePacks.map((pack) => pack.id)).toContain("pack-site");
  });

  it("refuses a new hostname that holds a DNS record before creating or uploading anything", async () => {
    account.dnsRecords.push({
      zoneId: "zone-1",
      name: `todo.${GW}`,
      type: "A",
      content: "192.0.2.10",
    });

    await expect(deployHere()).rejects.toMatchObject({
      code: "DNS_RECORD_CONFLICT",
      message: expect.stringContaining("--force-dns"),
    });
    expect(databaseId("every-acme-todo")).toBeUndefined();
    expect(account.workers.has("every-acme-todo")).toBe(false);
    expect(account.gatewayDomains()).toEqual([GW]);

    // The operator says the record may go.
    await expect(deployHere({ forceDns: true })).resolves.toMatchObject({
      hostname: `todo.${GW}`,
    });
    expect(account.gatewayDomains()).toEqual([GW, `todo.${GW}`]);
  });

  it("leaves the certificate to come on its own with --no-wait-cert, or after ten minutes", async () => {
    await deployHere({ waitForCertificate: false });
    expect(certificateChecks).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "app.tls", type: "progress" }),
    );

    // Another app whose certificate doesn't come in time: a warning, not a failure.
    events = [];
    const notes = { ...TODO, id: "notes", resources: { d1: ["DB"] } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
    otherDirs.push(dir);
    fs.writeFileSync(path.join(dir, "cloudflare.config.ts"), "everyAppWorker\n");
    account.apps.set(dir, notes);
    await expect(
      deployHere({
        cwd: dir,
        manifest: notes,
        certificates: {
          isReady: async () => false,
          sleep: async () => undefined,
          maxWaitMs: 0,
        },
      }),
    ).resolves.toMatchObject({ hostname: `notes.${GW}` });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CERT_PENDING" }),
    );
  });

  it("removes a deleted app's hostname, and the certificate Cloudflare keeps for it", async () => {
    await deployHere();
    expect(account.certificatePacks.map((pack) => pack.hosts)).toContainEqual([
      `todo.${GW}`,
    ]);

    await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: { ...seams, lookupCaa: account.lookupCaa },
    });

    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.certificatePacks.map((pack) => pack.hosts)).toEqual([[GW]]);
    await expect(readInstall(registry())).resolves.toMatchObject({
      liveDomains: [GW],
    });
    // Unknown hosts get a 404 from the gateway; its own still serves.
    expect(account.customDomains.has(`todo.${GW}`)).toBe(false);
    expect(account.customDomains.get(GW)).toBe("every-app-gateway");
  });

  it("deletes the app when its certificate can't be removed, and says so", async () => {
    await deployHere();
    account.cf.override(["ssl", "certificate-packs", "list"], {
      exitCode: 1,
      stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n",
    });

    await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: { ...seams, lookupCaa: account.lookupCaa },
    });

    expect(gateway.app("todo")).toMatchObject({ status: "deleted" });
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CERT_CLEANUP_FAILED" }),
    );
  });
});

describe("app delete", () => {
  beforeEach(async () => {
    await deploy();
  });

  it("deletes the app and drops its binding, keeping its Worker and data", async () => {
    await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect(gateway.app("todo")).toMatchObject({ status: "deleted" });
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.workers.has("every-acme-todo")).toBe(true);
    expect(account.namespaceId("every-acme-todo")).toBeTruthy();
  });

  it("purges only what the app recorded, never what merely has its names", async () => {
    // A legacy app the wrangler-era CLI deployed: nothing recorded yet.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy-chef', 'org-1', 'chef', 'Chef', 'Chef', 'chef-acme.example.com', 'every-chef', '{"id":"chef","resources":{"d1":["DB"]}}', 'active', 1);
    `);
    const legacyDb = account.createDatabase("every-chef");

    const result = await removeApp({
      appId: "chef",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect(databaseId("every-chef")).toBe(legacyDb.uuid);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "RESOURCES_KEPT",
        data: { kept: ['D1 database "every-chef"'] },
      }),
    );
    // Nothing was deleted, and the last word says so.
    expect(deletionSummary("chef", result)).toMatchObject({
      message: 'Deleted chef; kept D1 database "every-chef" (see above).',
      data: { purged: false, removed: [], kept: ['D1 database "every-chef"'] },
    });
  });

  it("never purges another app's database, even one recorded as the app's", async () => {
    // Legacy apps `chef` and `chef-archive`, and a record (made before
    // everyapp checked names) of chef-archive's database as chef's ARCHIVE.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names)
      VALUES ('legacy-chef', 'org-1', 'chef', 'Chef', 'Chef', 'chef-acme.example.com', 'every-chef', '{"id":"chef","resources":{"d1":["DB","ARCHIVE"]}}', 'active', 1),
        ('legacy-archive', 'org-1', 'chef-archive', 'Archive', 'Archive', 'chef-archive-acme.example.com', 'every-chef-archive', '{"id":"chef-archive"}', 'active', 1);
    `);
    const chefDb = account.createDatabase("every-chef");
    const theirs = account.createDatabase("every-chef-archive");
    await recordOwnedResource(registry(), "every-chef", {
      kind: "d1",
      binding: "DB",
      name: "every-chef",
      resourceId: chefDb.uuid,
    });
    await recordOwnedResource(registry(), "every-chef", {
      kind: "d1",
      binding: "ARCHIVE",
      name: "every-chef-archive",
      resourceId: theirs.uuid,
    });

    const result = await removeApp({
      appId: "chef",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect(databaseId("every-chef")).toBeUndefined();
    expect(databaseId("every-chef-archive")).toBe(theirs.uuid);
    expect(result.purged).toEqual({
      removed: ['D1 database "every-chef"'],
      kept: ['D1 database "every-chef-archive" (app chef-archive\'s)'],
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "RESOURCES_KEPT" }),
    );
  });

  it("purges the Worker, database and namespace on request", async () => {
    const result = await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect(account.workers.has("every-acme-todo")).toBe(false);
    expect([...account.databases.values()].map((db) => db.name)).toEqual([
      "every-app-gateway",
    ]);
    expect(account.namespaceId("every-acme-todo")).toBeUndefined();
    await expect(readOwnedResources(registry(), "every-acme-todo")).resolves.toEqual([]);
    expect(deletionSummary("todo", result).data).toMatchObject({ purged: true, kept: [] });
  });
});
