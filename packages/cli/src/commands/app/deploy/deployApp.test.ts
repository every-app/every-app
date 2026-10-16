/**
 * `everyapp app deploy` and `app delete` end to end: a fake Cloudflare
 * account behind FakeCf (real SQLite D1, Build Outputs validated with cf's
 * schema, the app's Worker built by the SDK's real everyAppWorker()) and the
 * gateway's deploy API over the same registry database.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionSummary, removeApp } from "@/commands/app/delete";
import { queryAppD1 } from "@/commands/app/d1";
import {
  changeInstanceStatus,
  listAppWorkflows,
  listInstances,
  startInstance,
} from "@/commands/app/workflows";
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
import { loseLeaseAtCheck, OTHER_HOLDER } from "@/test/loseLease";
import { deployApp } from "./deployApp";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));

const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
};

const WITH_WORKFLOW: EveryAppCliManifest = {
  ...TODO,
  resources: {
    ...TODO.resources,
    workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }],
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
/** Every new hostname has its certificate at once. */
const readyCertificates = {
  isReady: async () => true,
  sleep: async () => undefined,
};

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  account = new FakeCloudflare();
  gateway = new FakeGateway(account);

  // A gateway this CLI deployed at the zone's apex: each app is its own
  // Custom Domain at <app>.example.com. (One on a subdomain is below.)
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
    appBaseDomain: "example.com",
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
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
    installDeps: async () => undefined,
    reconcile: seams,
    certificates: readyCertificates,
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
    installDeps: async () => undefined,
    reconcile: seams,
    certificates: readyCertificates,
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
      liveUrl: "https://todo.example.com",
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

  it("sends the app's own secrets with the version, and later deploys keep them", async () => {
    await deploy(TODO, { secrets: { GITHUB_TOKEN: "ghp_test" } });

    const uploads = account.deploys.filter((d) => d.workerName === "every-acme-todo");
    expect(uploads.at(-1)!.secrets).toEqual({
      GITHUB_TOKEN: "ghp_test",
      GATEWAY_URL,
      EVERY_APP_ORG_ID: "org-1",
    });
    // A plain redeploy doesn't send it again; the Worker keeps it.
    await deploy();
    expect(account.deploys.filter((d) => d.workerName === "every-acme-todo").at(-1)!.secrets).toEqual({
      GATEWAY_URL,
      EVERY_APP_ORG_ID: "org-1",
    });
  });

  it("refuses a secret named like one everyapp sets, before anything happens", async () => {
    await expect(
      deploy(TODO, { secrets: { GATEWAY_URL: "https://evil.example" } }),
    ).rejects.toMatchObject({ code: "SECRET_NAME_RESERVED" });
    await expect(
      deploy(TODO, { secrets: { EVERYAPP_DEV: "1" } }),
    ).rejects.toMatchObject({ code: "SECRET_NAME_RESERVED" });
    expect(gateway.app("todo")).toBeUndefined();
    expect(account.deploys.filter((d) => d.workerName === "every-acme-todo")).toEqual([]);
  });

  it("refuses a secret named like one of the app's bindings, before anything happens", async () => {
    await expect(
      deploy(TODO, { secrets: { DB: "not-a-database" } }),
    ).rejects.toMatchObject({ code: "SECRET_NAME_TAKEN" });
    expect(gateway.app("todo")).toBeUndefined();
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

  it("stops unattended over an app Worker version it didn't record deploying, before migrating", async () => {
    await deploy();
    // Edited in the dashboard since, with a migration waiting to run.
    const worker = account.workers.get("every-acme-todo")!;
    worker.versions.push("dashboard-1");
    fs.writeFileSync(path.join(appDir, "drizzle", "0001_more.sql"), "CREATE TABLE more (id text);");
    const migrated = () => account.database("every-acme-todo").all("SELECT name FROM d1_migrations");

    await expect(deploy()).rejects.toMatchObject({ action: "rerun_interactive" });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }]);
    expect(worker.versions.at(-1)).toBe("dashboard-1");

    // At a terminal a person is asked first; once they say yes, the
    // recorded version lets the next unattended deploy go ahead.
    await expect(
      deploy(TODO, { interactive: true, confirm: async () => false }),
    ).rejects.toMatchObject({ code: "DEPLOY_CANCELLED" });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }]);
    await deploy(TODO, { interactive: true, confirm: async () => true });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }, { name: "0001_more.sql" }]);
    await expect(deploy()).resolves.toMatchObject({ workerName: "every-acme-todo" });
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

  it("keeps the upload when binding waits for a gateway deploy, and binds it next time", async () => {
    // A gateway upgrade that is still running.
    const upgrade = await acquireLease({
      db: registry(),
      id: "gateway",
      purpose: "gateway.upgrade",
      heartbeatMs: 0,
    });

    const held = await deploy().catch((error: Error) => error);
    expect(held).toMatchObject({ code: "LEASE_HELD", retryable: true });
    expect((held as Error).message).toContain(
      `${upgrade.holder} has held the gateway deploy lease (gateway.upgrade)`,
    );
    expect((held as Error).message).toContain("`everyapp gateway status` shows it");
    expect((held as Error).message).toContain("This app's upload is kept");
    expect((held as Error).message).not.toContain("--");
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(1);
    await expect(readLease(registry(), "app:every-acme-todo")).resolves.toBeNull();

    await upgrade.release();
    await expect(deploy()).resolves.toMatchObject({ workerName: "every-acme-todo" });
    expect(account.gatewayBindings()).toContain("every-acme-todo");
  });

  it("stops before migrating once its lease is lost", async () => {
    loseLeaseAtCheck(account, "app:every-acme-todo", 1);

    await expect(deploy()).rejects.toMatchObject({ code: "LEASE_LOST", retryable: true });
    expect(
      account.database("every-acme-todo").all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.get("every-acme-todo")).toBeUndefined();
    await expect(readLease(registry(), "app:every-acme-todo")).resolves.toMatchObject({
      holder: OTHER_HOLDER,
    });
  });

  it("stops before uploading once its lease is lost", async () => {
    loseLeaseAtCheck(account, "app:every-acme-todo", 2);

    await expect(deploy()).rejects.toMatchObject({ code: "LEASE_LOST" });
    expect(account.database("every-acme-todo").all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(account.workers.get("every-acme-todo")).toBeUndefined();
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

  it("refuses a Workflow name another Worker runs, before migrating or uploading", async () => {
    account.workflows.set("every-acme-todo--rank-check", {
      scriptName: "billing-api",
      className: "Run",
      instances: new Map(),
    });

    await expect(deploy(WITH_WORKFLOW)).rejects.toMatchObject({
      code: "WORKFLOW_NAME_TAKEN",
    });
    expect(account.workflows.get("every-acme-todo--rank-check")!.scriptName).toBe(
      "billing-api",
    );
    expect(
      account
        .database("every-acme-todo")
        .all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.has("every-acme-todo")).toBe(false);

    // Deployed without it, the app neither counts that Workflow as its own
    // nor touches it.
    await deploy();
    expect(account.workflows.get("every-acme-todo--rank-check")!.scriptName).toBe(
      "billing-api",
    );

    // Once the name is free, cf creates it for the app's Worker.
    account.workflows.delete("every-acme-todo--rank-check");
    await deploy(WITH_WORKFLOW);
    expect(account.workflows.get("every-acme-todo--rank-check")).toMatchObject({
      scriptName: "every-acme-todo",
      className: "RankCheckWorkflow",
    });
  });

  it("refuses to drop a Workflow without the flag, then deletes it once the upload is live", async () => {
    await deploy(WITH_WORKFLOW);

    await expect(deploy()).rejects.toMatchObject({ code: "WORKFLOW_REMOVED" });
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(1);
    expect(account.workflows.has("every-acme-todo--rank-check")).toBe(true);

    await deploy(TODO, { allowDeleteWorkflows: true });
    expect(account.workflows.has("every-acme-todo--rank-check")).toBe(false);
    const calls = account.cf.calls.map((call) => call.args.slice(0, 2).join(" "));
    expect(calls.lastIndexOf("workflows delete")).toBeGreaterThan(
      calls.lastIndexOf("deploy --prebuilt"),
    );
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

describe("app deploy's schema check", () => {
  const SCHEMA = `import { sqliteTable, text } from "drizzle-orm/sqlite-core";
export const todos = sqliteTable("todos", { id: text("id").primaryKey(), title: text("title") });
`;

  /**
   * Turn the fake app into a drizzle app: the starter template's
   * drizzle-kit and drizzle-orm, a schema, its config (which warns on
   * stderr, as the template's does without a local database), and the
   * migration drizzle-kit generates for that schema in place of the
   * fixture's.
   */
  async function useDrizzle(): Promise<void> {
    const template = path.join(REPO, "templates/simple-todo/node_modules");
    fs.mkdirSync(path.join(appDir, "node_modules"));
    for (const name of ["drizzle-kit", "drizzle-orm"]) {
      fs.symlinkSync(
        fs.realpathSync(path.join(template, name)),
        path.join(appDir, "node_modules", name),
        "junction",
      );
    }
    fs.mkdirSync(path.join(appDir, "src", "db"), { recursive: true });
    fs.writeFileSync(path.join(appDir, "src", "db", "schema.ts"), SCHEMA);
    fs.writeFileSync(
      path.join(appDir, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
console.error("WARNING: no local D1 database yet");
export default defineConfig({ dialect: "sqlite", schema: "./src/db/schema.ts", out: "./drizzle" });
`,
    );
    fs.rmSync(path.join(appDir, "drizzle"), { recursive: true });
    await execa(process.execPath, [path.join(appDir, "node_modules", "drizzle-kit", "bin.cjs"), "generate"], {
      cwd: appDir,
      stdin: "ignore",
    });
  }

  const migrationsOf = () => fs.readdirSync(path.join(appDir, "drizzle"), { recursive: true }).sort();
  const scratchLeft = () =>
    fs.existsSync(path.join(appDir, ".everyapp"))
      ? fs.readdirSync(path.join(appDir, ".everyapp")).filter((name) => name.startsWith("schema-check-"))
      : [];
  const schemaEvents = () => events.filter((event) => event["step"] === "app.schema");

  it("goes on when the migrations describe the schema", async () => {
    await useDrizzle();
    const before = migrationsOf();

    await deploy();

    expect(schemaEvents()).toEqual([
      expect.objectContaining({ type: "step", status: "start" }),
      expect.objectContaining({ type: "step", status: "ok", message: "schema in sync" }),
    ]);
    expect(account.database("every-acme-todo").all("SELECT name FROM d1_migrations")).toEqual([
      { name: migrationsOf().find((file) => String(file).endsWith(".sql")) },
    ]);
    expect(migrationsOf()).toEqual(before);
    expect(scratchLeft()).toEqual([]);
  });

  it("stops before migrating or uploading when the schema changed without a migration", async () => {
    await useDrizzle();
    const before = migrationsOf();
    fs.writeFileSync(
      path.join(appDir, "src", "db", "schema.ts"),
      SCHEMA.replace('title: text("title")', 'title: text("title"), done: text("done")'),
    );

    await expect(deploy()).rejects.toMatchObject({
      code: "SCHEMA_DRIFT",
      message: expect.stringContaining("Run `pnpm db:generate`, then deploy again"),
    });
    expect(
      account.database("every-acme-todo").all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'"),
    ).toEqual([]);
    expect(account.workers.get("every-acme-todo")).toBeUndefined();
    // The app's own migrations are left as they were.
    expect(migrationsOf()).toEqual(before);
    expect(scratchLeft()).toEqual([]);
  });

  it("stops when drizzle-kit can't tell, as on a renamed column it asks about", async () => {
    await useDrizzle();
    fs.writeFileSync(
      path.join(appDir, "src", "db", "schema.ts"),
      SCHEMA.replace('title: text("title")', 'name: text("name")'),
    );

    await expect(deploy()).rejects.toMatchObject({
      code: "SCHEMA_CHECK_FAILED",
      message: expect.stringContaining("Run `pnpm db:generate` in a terminal"),
    });
    expect(account.workers.get("every-acme-todo")).toBeUndefined();
    expect(scratchLeft()).toEqual([]);
  });

  it("warns and goes on when the app has no drizzle-kit", async () => {
    await deploy();

    expect(schemaEvents()).toEqual([
      expect.objectContaining({
        type: "warning",
        code: "SCHEMA_CHECK_SKIPPED",
        message: expect.stringContaining("drizzle-kit isn't installed"),
      }),
    ]);
    expect(account.database("every-acme-todo").all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
  });
});

describe("app workflows", () => {
  const options = () => ({
    cwd: appDir,
    gatewayUrl: GATEWAY_URL,
    interactive: false,
    client: gateway.client,
    createCf: () => account.cf,
  });

  beforeEach(async () => {
    await deploy(WITH_WORKFLOW);
    fs.writeFileSync(
      path.join(appDir, "everyapp.config.ts"),
      `export default ${JSON.stringify(WITH_WORKFLOW)};\n`,
    );
  });

  it("starts, lists and controls the app's Workflow instances by binding", async () => {
    await expect(
      startInstance({ ...options(), workflow: "RANK_CHECK", params: '{"site":"a"}', instanceId: "run-1" }),
    ).resolves.toMatchObject({ instance: { id: "run-1", status: "queued" } });
    expect(
      account.workflows.get("every-acme-todo--rank-check")!.instances.get("run-1"),
    ).toEqual({ status: "queued", params: { site: "a" } });

    await changeInstanceStatus({ ...options(), workflow: "RANK_CHECK", instanceId: "run-1", status: "pause" });
    await expect(
      listInstances({ ...options(), workflow: "every-acme-todo--rank-check", status: "paused" }),
    ).resolves.toEqual([{ id: "run-1", status: "paused" }]);

    // Terminating is for good: unattended, only with --yes.
    await expect(
      changeInstanceStatus({ ...options(), workflow: "RANK_CHECK", instanceId: "run-1", status: "terminate" }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await changeInstanceStatus({
      ...options(),
      workflow: "RankCheckWorkflow",
      instanceId: "run-1",
      status: "terminate",
      yes: true,
    });
    await expect(listAppWorkflows(options())).resolves.toEqual([
      expect.objectContaining({
        binding: "RANK_CHECK",
        name: "every-acme-todo--rank-check",
        deployed: true,
        instances: { terminated: 1 },
      }),
    ]);
  });

  it("touches only Workflows the app declares and its Worker runs", async () => {
    await expect(
      startInstance({ ...options(), workflow: "BILLING" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });

    account.workflows.get("every-acme-todo--rank-check")!.scriptName = "billing-api";
    await expect(
      startInstance({ ...options(), workflow: "RANK_CHECK" }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_DEPLOYED" });
    expect(account.workflows.get("every-acme-todo--rank-check")!.instances.size).toBe(0);
  });
});

describe("app deploy and delete with the gateway on a subdomain", () => {
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
      appBaseDomain: GW,
      resources,
      db: cfD1Database(account.cf, resources.d1Id),
      interactive: false,
      cliVersion: "0.3.0",
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
      installDeps: async () => undefined,
      reconcile: seams,
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
      INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status)
        VALUES ('row-todo', 'org-1', 'todo', 'todo', 'todo', 'todo.example.com', 'every-acme-todo', '{}', 'pending');
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
      reconcile: seams,
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
      reconcile: seams,
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
      reconcile: seams,
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
    // App chef is registered, but its deploy never created anything: the
    // database with its name is someone else's.
    const chef: EveryAppCliManifest = { id: "chef", resources: { d1: ["DB"] } };
    const theirs = account.createDatabase("every-acme-chef");
    await expect(deployOther(chef)).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });

    const result = await removeApp({
      appId: "chef",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect(databaseId("every-acme-chef")).toBe(theirs.uuid);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "RESOURCES_KEPT",
        data: { kept: ['D1 database "every-acme-chef"'] },
      }),
    );
    // Nothing was deleted, and the last word says so.
    expect(deletionSummary("chef", result)).toMatchObject({
      message: 'Deleted chef; kept D1 database "every-acme-chef" (see above).',
      data: { purged: false, removed: [], kept: ['D1 database "every-acme-chef"'] },
    });
  });

  it("purges the Workflows that run on the app's Worker, and no others", async () => {
    await deploy(WITH_WORKFLOW);
    // Named with this app's Worker name as a prefix, but app todo-archive's.
    account.workflows.set("every-acme-todo-archive--sync", {
      scriptName: "every-acme-todo-archive",
      className: "Sync",
      instances: new Map(),
    });
    // Named like the app's, but another Worker runs it.
    account.workflows.set("every-acme-todo--import", {
      scriptName: "billing-api",
      className: "Import",
      instances: new Map(),
    });

    const result = await removeApp({
      appId: "todo",
      client: gateway.client,
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: seams,
    });

    expect([...account.workflows.keys()].sort()).toEqual([
      "every-acme-todo--import",
      "every-acme-todo-archive--sync",
    ]);
    expect(result.purged?.removed).toContain('Workflow "every-acme-todo--rank-check"');
    expect(result.purged?.kept).toEqual([
      `Workflow "every-acme-todo--import" (Worker billing-api's)`,
    ]);
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
