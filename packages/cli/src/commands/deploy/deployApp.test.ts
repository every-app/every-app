/**
 * `everyapp deploy` and `delete` end to end: a fake Cloudflare
 * account behind FakeCf (real SQLite D1, Build Outputs validated with cf's
 * schema, the app's Worker built by the SDK's real everyAppWorker()). The
 * registry is the gateway's D1 there, which the CLI writes itself; the
 * deployed gateway Worker answers the live wait and activates apps it binds
 * (test/gatewayWorker.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deletionSummary, removeApp } from "@/commands/delete";
import { queryAppD1 } from "@/commands/db";
import { restoreDatabase } from "@/commands/db/restore";
import {
  changeInstanceStatus,
  listAppWorkflows,
  listInstances,
  startInstance,
} from "@/commands/workflow";
import { readOwnedResources, recordOwnedResource } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { rollbackFor } from "@/lib/errors";
import { applyGateway } from "@/lib/gateway/apply";
import { readInstall } from "@/lib/gateway/install";
import { reconcileGateway } from "@/lib/gateway/reconcile";
import { deleteApp as deleteFromRegistry } from "@/lib/gateway/registry";
import { mintSetupLink } from "@/lib/gateway/setup-link";
import { handleInterrupt, resetInterruptsForTests } from "@/lib/interrupt";
import { LeasePurpose, readLease } from "@/lib/gateway/lease";
import { holdLease } from "@/test/holdLease";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { CLI } from "@/lib/output/command";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { loseLeaseAtCheck, OTHER_HOLDER } from "@/test/loseLease";
import { sqliteD1Script } from "@/test/sqliteD1";
import { deployApp } from "./deployApp";

const GATEWAY_URL = "https://example.com";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

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
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;
const otherDirs: string[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = {
  sleep: async () => undefined,
  leaseWaitMs: 0,
};
/** A rebind deploys the release "this checkout builds": the one installed. */
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};
/** The live wait reaches the fake gateway Worker, and never sleeps. */
const live = () => ({ fetch: worker.fetch, sleep: async () => undefined });

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  // A person's Cloudflare login, not CI's API token.
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);

  // A gateway this CLI deployed at the zone's apex: each app is its own
  // Custom Domain at <app>.example.com. (One on a subdomain is below.) It
  // has no owner, and no organization, yet.
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
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
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: live(),
    ...options,
  });
}

/** `delete`, unattended, in the fake account. */
function remove(appId: string, purge = false) {
  return removeApp({
    appId,
    out: out(),
    interactive: false,
    purge,
    createCf: () => account.cf,
    reconcile: rebind,
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
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: live(),
  });
}

const gatewayDatabaseId = () =>
  [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0];
const registry = () => cfD1Database(account.cf, gatewayDatabaseId());

const databaseId = (name: string) =>
  [...account.databases].find(([, db]) => db.name === name)?.[0];

/** The registry's row for an app, as the gateway reads it. */
const appRow = (appId: string) =>
  account
    .database("every-app-gateway")
    .all(
      "SELECT id, organization_id, worker_name, hostname, status, version_id, deployed_by_actor FROM apps WHERE app_slug = ?",
      appId,
    )[0];

/** The install's organization, which the first deploy made. */
const organizationId = () =>
  String(account.database("every-app-gateway").all("SELECT id FROM organizations")[0]!["id"]);

describe("deploy", () => {
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
    // the gateway's identity key from its install row, its source maps
    // listed, and the secrets in the same version.
    const install = (await readInstall(registry()))!;
    const upload = account.deploys.find((d) => d.workerName === "every-acme-todo")!;
    expect(upload.config["env"]).toMatchObject({
      DB: { type: "d1", name: "every-acme-todo" },
      // The audience the gateway mints this Worker's identities for.
      EVERYAPP_AUDIENCE: { type: "text", value: "every-acme-todo" },
      EVERYAPP_IDENTITY_ISSUER: { type: "text", value: GATEWAY_URL },
      EVERYAPP_IDENTITY_PUBLIC_KEYS: {
        type: "text",
        value: JSON.stringify([install.jwtPublicKey]),
      },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: { organizationId: organizationId(), appId: "todo", workerName: "every-acme-todo" },
      },
    });
    // The very key the gateway signs with.
    expect(install.jwtPublicKey).toBe(
      account.deploys.find((d) => d.workerName === "every-app-gateway")!.secrets!["JWT_PUBLIC_KEY"],
    );
    expect(upload.config["env"].EVERYAPP_DEV).toBeUndefined();
    expect(upload.config["manifest"].modules).toEqual({
      "assets/x.js.map": { type: "sourcemap" },
    });
    expect(upload.secrets).toEqual({
      GATEWAY_URL,
      EVERY_APP_ORG_ID: organizationId(),
    });
    // The build was tenant-neutral; the deploy installed every placeholder.
    expect(JSON.stringify(upload.config)).not.toContain("sentinel");

    // The gateway now binds it, and its first request made the app live; the
    // registry records the version (the gateway takes its agent tools from
    // it) and who deployed it.
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(appRow("todo")).toMatchObject({
      status: "active",
      version_id: account.workers.get("every-acme-todo")!.versions.at(-1),
      deployed_by_actor: "dev@example.com",
    });
    expect(worker.requests).toEqual(["https://todo.example.com/"]);
    // Migrations ran before the upload, the gateway was reconciled after it.
    const steps = events
      .filter((event) => event["type"] === "step" && event["status"] !== "start")
      .map((event) => event["step"]);
    expect(steps).toEqual([
      "app.connect",
      "app.deploy",
      "app.register",
      "app.resources",
      "app.install",
      "app.build",
      "app.migrations",
      "app.upload",
      "gateway.deploy",
      "app.bind",
      "app.live",
    ]);
    // What a person sees of it comes from these events' data. Before the
    // gateway has an owner, the app is in the organization named after the
    // Cloudflare account, and nobody has access to it yet.
    expect(events.find((event) => event["step"] === "app.register")).toMatchObject({
      data: {
        appId: "todo",
        hostname: "todo.example.com",
        existingApp: false,
        defaultAccess: false,
        deployerAccess: false,
        organizationName: "Acme",
        firstDeploy: true,
        hasOwner: false,
      },
    });
    // A new database: nothing to restore it to.
    expect(events.find((event) => event["step"] === "app.migrations" && event["status"] === "ok")).toEqual(
      expect.objectContaining({ data: { applied: ["0000_init.sql"], fresh: true } }),
    );
    expect(events.find((event) => event["step"] === "app.live")).toMatchObject({
      data: { hostname: "todo.example.com", url: "https://todo.example.com" },
    });
    const leases = account.database("every-app-gateway").all(
      "SELECT * FROM _everyapp_deploy_lease",
    );
    expect(leases).toEqual([]);
    // Nothing went to the gateway over HTTPS but the live wait's request.
    expect(account.cf.calls.some((call) => call.args.join(" ").includes("/api/"))).toBe(false);
  });

  it("gives the deployer access once the gateway has an owner and they are a verified member", async () => {
    await deploy();
    // The owner claims the gateway: they adopt the organization todo is in,
    // and get todo, which nobody had access to.
    const link = await mintSetupLink({ db: registry(), gatewayUrl: GATEWAY_URL });
    const { userId: ownerId, organizationId: claimed } = worker.claim(link.url, {
      email: "owner@example.com",
    });
    expect(claimed).toBe(organizationId());
    // The Cloudflare login's email is a verified member's.
    const db = account.database("every-app-gateway");
    db.sqlite.exec(`
      INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('dev', 'Dev', 'dev@example.com', 1, 0, 0);
      INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('member-dev', '${claimed}', 'dev', 'member', 0);
    `);
    events = [];

    await deployOther({ id: "chef" });

    const granted = (appId: string) =>
      db
        .all(
          "SELECT user_id FROM user_app_access WHERE app_row_id = (SELECT id FROM apps WHERE app_slug = ?) ORDER BY user_id",
          appId,
        )
        .map((row) => row["user_id"]);
    expect(granted("todo")).toEqual([ownerId]);
    expect(granted("chef").sort()).toEqual(["dev", ownerId].sort());
    expect(events.find((event) => event["step"] === "app.register")).toMatchObject({
      data: { deployerAccess: true, organizationName: "Owner" },
    });
  });

  it("removes a Gateway setting, then redeploys the Gateway as everyapp's own", async () => {
    const reconcile = (change: Partial<Parameters<typeof reconcileGateway>[0]>) =>
      reconcileGateway({
        cf: account.cf,
        out: out(),
        accountId: ACCOUNT_ID,
        databaseId: gatewayDatabaseId(),
        openRelease: () => openRelease(tarball),
        interactive: false,
        cliVersion: "0.3.0",
        force: true,
        ...seams,
        ...change,
      });
    await reconcile({ stagedSecrets: { OPENAI_API_KEY: "sk-test" } });
    expect(account.workers.get("every-app-gateway")!.secrets).toHaveProperty("OPENAI_API_KEY");

    const result = await reconcile({ unsetSecrets: ["OPENAI_API_KEY"] });

    expect(account.workers.get("every-app-gateway")!.secrets).not.toHaveProperty("OPENAI_API_KEY");
    await expect(readInstall(registry())).resolves.toMatchObject({
      liveVersionId: result.versionId,
    });
    expect(result.versionId).toBe(account.workers.get("every-app-gateway")!.versions.at(-1));
  });

  it("redeploys an app's code without touching the gateway", async () => {
    await deploy();
    const before = gatewayVersions();
    worker.requests.length = 0;

    await deploy({ ...TODO, description: "v2" });

    expect(gatewayVersions()).toBe(before);
    expect(account.workers.get("every-acme-todo")!.versions).toHaveLength(2);
    // Live already: no request needed. The new version is recorded, which
    // is how the gateway knows to take the new code's agent tools.
    expect(worker.requests).toEqual([]);
    expect(appRow("todo")).toMatchObject({
      status: "active",
      version_id: account.workers.get("every-acme-todo")!.versions[1],
    });
    expect(events.filter((event) => event["step"] === "app.live" && event["status"] === "ok")).toHaveLength(2);
  });

  it("refuses someone else's database on every attempt, not just the first", async () => {
    const foreign = account.createDatabase("every-acme-todo");
    foreign.db.sqlite.exec("CREATE TABLE theirs (v TEXT); INSERT INTO theirs VALUES ('not yours');");

    await expect(deploy()).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    // The failed attempt left the app registered...
    expect(appRow("todo")).toMatchObject({ status: "pending" });
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

    await remove("notes", true);
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

    // `needsTerminal` tells an agent to hand the rerun to a person, not loop on it.
    await expect(deploy()).rejects.toMatchObject({
      action: "rerun_interactive",
      rerunNote: "in a terminal",
      data: { workerName: "every-acme-todo", versionId: "dashboard-1", needsTerminal: true },
    });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }]);
    expect(worker.versions.at(-1)).toBe("dashboard-1");

    // At a terminal a person is asked first; once they say yes, the
    // recorded version lets the next unattended deploy go ahead.
    await expect(
      deploy(TODO, { interactive: true, confirm: async () => false }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }]);
    await deploy(TODO, { interactive: true, confirm: async () => true });
    expect(migrated()).toEqual([{ name: "0000_init.sql" }, { name: "0001_more.sql" }]);
    await expect(deploy()).resolves.toMatchObject({ workerName: "every-acme-todo" });
  });

  it("lets a retry go unattended after a deploy that uploaded but couldn't record it in the registry", async () => {
    await deploy();
    // The next deploy uploads, then D1 can't be reached to record it.
    let failed = false;
    account.cf.override(["d1", "query"], (call) => {
      if (!failed && (call.files["query.json"] ?? "").includes("UPDATE apps SET manifest")) {
        failed = true;
        return { exitCode: 1, stderr: "┌ Error\n│ fetch failed\n└\n" };
      }
      const databaseId = call.args[2]!;
      return sqliteD1Script({ [databaseId]: account.databases.get(databaseId)!.db })(call);
    });
    await expect(deploy({ ...TODO, description: "v2" })).rejects.toThrow("fetch failed");
    const uploaded = account.workers.get("every-acme-todo")!.versions.at(-1);
    expect(appRow("todo")!["version_id"]).not.toBe(uploaded);

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

  it("keeps the upload when binding waits for a deploy of the gateway, and binds it next time", async () => {
    // An upgrade of the gateway, still running.
    const upgrade = await holdLease(registry(), "gateway", LeasePurpose.GatewayUpgrade);

    const held = await deploy().catch((error: Error) => error);
    expect(held).toMatchObject({ code: "LEASE_HELD", retryable: true });
    // Who holds it: the deployer when that run knew its login, and the machine.
    const machine = upgrade.holder.split(":")[0]!.split(".")[0]!;
    expect((held as Error).message).toMatch(
      new RegExp(`It's from (dev@example\\.com on )?${machine}\\. If it stopped`),
    );
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

    const failure = await deploy().catch((error: unknown) => error);
    expect(failure).toMatchObject({ action: "register_workers_subdomain" });
    // The database was migrated first, but it was new: nothing to put back.
    expect(rollbackFor(failure)).toBeUndefined();
    // Registered and provisioned; the next run picks it up, with the same
    // database and namespace it created.
    expect(appRow("todo")).toMatchObject({ status: "pending" });
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
        out: out(),
        createCf: () => account.cf,
      }),
    ).resolves.toMatchObject([{ rows: [{ title: "ship it" }] }]);

    // A write needs a person to say yes, or --yes.
    const write = {
      cwd: appDir,
      sql: "DELETE FROM todos",
      local: false,
      out: out(),
      createCf: () => account.cf,
      interactive: false,
    };
    await expect(queryAppD1(write)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    await expect(
      queryAppD1({ ...write, interactive: true, confirm: async () => false }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(account.database("every-acme-todo").all("SELECT title FROM todos")).toHaveLength(1);
    await queryAppD1({ ...write, yes: true });
    expect(account.database("every-acme-todo").all("SELECT title FROM todos")).toEqual([]);

    // The SQL's own error, said as such.
    await expect(
      queryAppD1({ ...write, sql: "SELECT * FROM todo" }),
    ).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Query failed: no such table: todo\nSQLITE_ERROR from the production database.",
    });
  });

  it("saves a restore point when a redeploy migrates the database, and db restore puts it back", async () => {
    await deploy();
    fs.writeFileSync(
      path.join(appDir, "drizzle", "0001_done.sql"),
      "ALTER TABLE todos ADD done integer;",
    );
    fs.writeFileSync(
      path.join(appDir, "everyapp.config.ts"),
      `export default ${JSON.stringify(TODO)};\n`,
    );
    events = [];

    await deploy();

    expect(events.find((event) => event["step"] === "app.migrations" && event["status"] === "ok")).toMatchObject({
      data: {
        applied: ["0001_done.sql"],
        fresh: false,
        restoreCommand: `${CLI} db restore`,
        rollbackCommand: expect.stringContaining("d1 time-travel restore"),
      },
    });
    const registry = account.database("every-app-gateway");
    const [point] = registry.all("SELECT * FROM _everyapp_restore_points");
    expect(point).toMatchObject({
      target: "app:every-acme-todo",
      database_id: databaseId("every-acme-todo"),
      migrations: '["0001_done.sql"]',
      created_by: "dev@example.com",
    });

    const restore = (options: Partial<Parameters<typeof restoreDatabase>[0]> = {}) =>
      restoreDatabase({
        cwd: appDir,
        gateway: false,
        yes: false,
        json: true,
        out: out(),
        createCf: () => account.cf,
        interactive: true,
        ...options,
      });
    const asked: string[] = [];
    await restore({ confirm: async (question) => (asked.push(question), true) });

    expect(asked).toEqual([
      "Put todo's database back to before 1 migration (0001_done.sql) applied 0s ago by dev@example.com?",
    ]);
    expect(account.restores).toEqual([
      { databaseId: databaseId("every-acme-todo"), bookmark: point!["bookmark"] },
    ]);
    // Used up, and the lease freed.
    expect(registry.all("SELECT * FROM _everyapp_restore_points")).toEqual([]);
    expect(registry.all("SELECT * FROM _everyapp_deploy_lease")).toEqual([]);
    await expect(restore({ yes: true })).rejects.toMatchObject({ code: "NO_RESTORE_POINT" });
    // The Gateway was installed into an empty database: nothing to go back to.
    await expect(restore({ gateway: true, yes: true })).rejects.toMatchObject({
      code: "NO_RESTORE_POINT",
      message: expect.stringMatching(/^No restore point for the Gateway's database\n/),
    });
  });

  it("says how to restore the database when the upload fails after a migration", async () => {
    await deploy();
    fs.writeFileSync(
      path.join(appDir, "drizzle", "0001_done.sql"),
      "ALTER TABLE todos ADD done integer;",
    );
    account.failNextDeploy = "an internal error occurred [code: 10013]";

    const failure = await deploy().catch((error: unknown) => error);

    expect(rollbackFor(failure)).toEqual({
      restoreCommand: `${CLI} db restore`,
      rollbackCommand: expect.stringContaining("d1 time-travel restore"),
    });
  });

  it("goes live on its first visit behind Cloudflare Access, and says so", async () => {
    worker.accessInFront.add("todo.example.com");

    await expect(deploy()).resolves.toMatchObject({
      live: false,
      liveUrl: "https://todo.example.com",
    });

    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(appRow("todo")).toMatchObject({ status: "binding" });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "ACCESS_IN_FRONT" }),
    );
    expect(events.some((event) => event["step"] === "app.live" && event["status"] === "ok")).toBe(false);

    // The first visit through Access reaches the gateway, which activates it.
    worker.accessInFront.clear();
    await worker.fetch("https://todo.example.com/");
    expect(appRow("todo")).toMatchObject({ status: "active" });
  });

  it("waits through a certificate on its way and a gateway version still rolling out", async () => {
    worker.certificatePending.add("todo.example.com");
    let requests = 0;
    const rollingOut = (async (input: Parameters<typeof fetch>[0]) => {
      requests += 1;
      if (requests === 2) {
        // The certificate came, but the edge still runs the gateway version
        // without the binding.
        worker.certificatePending.clear();
        return Response.json({ code: "app_deploying" }, { status: 503 });
      }
      return worker.fetch(input);
    }) as typeof fetch;

    await expect(
      deploy(TODO, { live: { fetch: rollingOut, sleep: async () => undefined } }),
    ).resolves.toMatchObject({ live: true });
    expect(requests).toBe(3);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "progress", step: "app.live" }),
    );
  });

  it("records an API token as the deployer, and grants it nobody", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token-from-ci");

    await deploy();

    expect(appRow("todo")).toMatchObject({ deployed_by_actor: `api-token:${ACCOUNT_ID}` });
  });

  it("logs in through cf's device link under --json, and waits for it, on deploy and delete", async () => {
    let approved = false;
    const logOut = () => {
      approved = false;
    };
    account.cf
      .override(["auth", "whoami"], () => ({
        stdout: JSON.stringify(
          approved
            ? { authenticated: true, email: "dev@example.com", accounts: [{ id: ACCOUNT_ID, name: "Acme" }] }
            : { authenticated: false },
        ),
      }))
      .override(["auth", "login"], () => {
        approved = true;
        return {
          stdout: "please visit:\n\n  https://dash.cloudflare.com/oauth2/device\n\nand enter the code:\n\n  ABCD-EFGH\n",
        };
      });
    const login = expect.objectContaining({
      type: "action_required",
      action: "cloudflare_login",
      data: { url: "https://dash.cloudflare.com/oauth2/device", code: "ABCD-EFGH", expiresAt: expect.any(String), waiting: true, waitingFor: "Cloudflare login" },
    });

    await expect(deploy(TODO, { json: true })).resolves.toMatchObject({ live: true });
    expect(events.filter((event) => event["type"] === "action_required")).toEqual([login]);

    logOut();
    events = [];
    await removeApp({
      appId: "todo",
      out: out(),
      json: true,
      interactive: false,
      purge: false,
      createCf: () => account.cf,
      reconcile: rebind,
    });
    expect(events.filter((event) => event["type"] === "action_required")).toEqual([login]);
    expect(appRow("todo")).toMatchObject({ status: "deleted" });
  });

  it("refuses a checkout behind the live Gateway, before anything happens, and says git pull", async () => {
    // A checkout that hasn't pulled the Gateway that is live.
    const behind = {
      ...rebind,
      source: async () => ({
        ...(await releaseSource(tarball)),
        version: "0.1.0",
        order: { schema: 0, committedAt: 0 },
      }),
    };

    const refused = await deploy(TODO, { reconcile: behind }).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      code: "DOWNGRADE_REFUSED",
      message: "This checkout's Gateway (0.1.0) is older than the live one (0.2.0)",
      fix: "git pull",
      rerun: expect.stringMatching(/^pnpm everyapp/),
      authorize: false,
    });
    expect((refused as { rerun: string }).rerun).not.toContain("--allow-downgrade");
    expect(appRow("todo")).toBeUndefined();
    expect(account.workers.has("every-acme-todo")).toBe(false);

    // Nor does a delete touch the registry.
    await deploy();
    await expect(
      removeApp({
        appId: "todo",
        out: out(),
        interactive: false,
        purge: false,
        createCf: () => account.cf,
        reconcile: behind,
      }),
    ).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });
    expect(appRow("todo")).toMatchObject({ status: "active" });
  });

  it("refuses a --gateway that isn't the one in the Cloudflare account, before anything happens", async () => {
    await expect(deploy(TODO, { gateway: "https://other.example.net" })).rejects.toMatchObject({
      code: "GATEWAY_URL_MISMATCH",
    });
    await expect(deploy(TODO, { gateway: `${GATEWAY_URL}/` })).resolves.toMatchObject({
      gatewayUrl: GATEWAY_URL,
    });
  });

  it("needs the gateway's identity key in its install row", async () => {
    account.database("every-app-gateway").sqlite.exec("UPDATE _everyapp_install SET jwt_public_key = NULL");

    await expect(deploy()).rejects.toMatchObject({
      code: "IDENTITY_KEY_UNKNOWN",
      fix: expect.stringContaining("key-rotation.md"),
    });
    expect(appRow("todo")).toBeUndefined();
  });
});

describe("deploy's schema check", { timeout: 30_000 }, () => {
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
      expect.objectContaining({ type: "step", status: "ok" }),
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
      rerun: "pnpm db:generate",
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
      rerun: "pnpm db:generate",
      rerunNote: expect.stringContaining("in a terminal"),
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

describe("deploy of an app without helper Workers", () => {
  /** Ids and paths that differ on every run, replaced by what they are. */
  function stable(value: unknown): unknown {
    const replacements: Array<[string, string]> = [
      [organizationId(), "<organization>"],
      [appDir, "<app>"],
      [os.tmpdir(), "<tmp>"],
    ];
    let text = JSON.stringify(value);
    for (const [from, to] of replacements) text = text.split(from).join(to);
    text = text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
      .replace(/[0-9a-f]{32}/g, "<id>")
      .replace(/-----BEGIN PUBLIC KEY-----[^"]*?-----END PUBLIC KEY-----\\\\n/g, "<public key>")
      .replace(/"every-acme-todo-version-\d+"/g, '"<version>"');
    return JSON.parse(text);
  }

  it("builds, uploads and records exactly what it did before helper Workers", async () => {
    account.cf.calls.length = 0;
    await deploy(WITH_WORKFLOW);

    const uploads = account.deploys.filter((upload) =>
      upload.workerName.startsWith("every-acme-todo"),
    );
    expect(
      stable({
        // The registry's own queries are left out: `owned` shows what they record.
        cf: account.cf.calls
          .filter((call) => call.args[0] !== "d1" || call.args[1] !== "query")
          .map((call) => call.args.join(" ")),
        uploads: uploads.map(({ workerName, config, args, secrets }) => ({
          workerName,
          args,
          secrets: Object.keys(secrets ?? {}),
          env: config["env"],
          exports: config["exports"],
          modules: config["manifest"].modules,
        })),
        owned: await readOwnedResources(registry(), "every-acme-todo"),
        built: events.find(
          (event) => event["step"] === "app.build" && event["status"] === "ok",
        )?.["data"],
      }),
    ).toMatchInlineSnapshot(`
      {
        "built": {
          "release": false,
          "workflows": [
            "every-acme-todo--rank-check",
          ],
        },
        "cf": [
          "auth whoami",
          "d1 list --name every-app-gateway --per-page 100",
          "dns records list -z zone-1 --name-exact todo.example.com --per-page 100",
          "dns records list -z zone-1 --name-exact *.example.com --per-page 100",
          "workers deployments list --worker every-acme-todo --per-page 10",
          "d1 list --name every-acme-todo --per-page 100",
          "d1 create --name every-acme-todo",
          "kv namespaces list --per-page 100 --page 1",
          "kv namespaces create --title every-acme-todo",
          "build",
          "workflows get every-acme-todo--rank-check",
          "workers deployments list --worker every-acme-todo --per-page 10",
          "d1 migrations list <uuid> --dir <app>/drizzle",
          "d1 migrations apply <uuid> --dir <app>/drizzle",
          "workers deployments list --worker every-acme-todo --per-page 10",
          "deploy --prebuilt --mode production --message everyapp 0.3.0 todo --secrets-file /fake-cf-files/secrets.json",
          "workers deployments list --worker every-acme-todo --per-page 10",
          "workers deployments list --worker every-app-gateway --per-page 10",
          "workers deployments list --worker every-acme-todo --per-page 10",
          "dns records list -z zone-1 --name-exact todo.example.com --per-page 100",
          "dns records list -z zone-1 --name-exact *.example.com --per-page 100",
          "workers deployments list --worker every-app-gateway --per-page 10",
          "deploy --prebuilt --mode production --message everyapp 0.3.0 gateway 0.2.0 (reconcile)",
          "workers deployments list --worker every-app-gateway --per-page 10",
          "zero-trust access applications list --per-page 100 --page 1",
        ],
        "owned": [
          {
            "binding": "DB",
            "kind": "d1",
            "name": "every-acme-todo",
            "resourceId": "<uuid>",
            "versionId": null,
          },
          {
            "binding": "KV",
            "kind": "kv",
            "name": "every-acme-todo",
            "resourceId": "<id>",
            "versionId": null,
          },
          {
            "binding": "",
            "kind": "worker",
            "name": "every-acme-todo",
            "resourceId": "every-acme-todo",
            "versionId": "<version>",
          },
        ],
        "uploads": [
          {
            "args": [
              "deploy",
              "--prebuilt",
              "--mode",
              "production",
              "--message",
              "everyapp 0.3.0 todo",
              "--secrets-file",
              "/fake-cf-files/secrets.json",
            ],
            "env": {
              "CF_VERSION_METADATA": {
                "type": "version-metadata",
              },
              "DB": {
                "id": "<uuid>",
                "name": "every-acme-todo",
                "type": "d1",
              },
              "EVERYAPP_APP_ID": {
                "type": "text",
                "value": "todo",
              },
              "EVERYAPP_AUDIENCE": {
                "type": "text",
                "value": "every-acme-todo",
              },
              "EVERYAPP_IDENTITY_ISSUER": {
                "type": "text",
                "value": "https://example.com",
              },
              "EVERYAPP_IDENTITY_PUBLIC_KEYS": {
                "type": "text",
                "value": "["<public key>"]",
              },
              "EVERY_APP_GATEWAY": {
                "exportName": "AppGateway",
                "props": {
                  "appId": "todo",
                  "organizationId": "<organization>",
                  "workerName": "every-acme-todo",
                },
                "type": "worker",
                "worker": "every-app-gateway",
              },
              "EVERY_APP_ORG_ID": {
                "type": "secret",
              },
              "GATEWAY_URL": {
                "type": "secret",
              },
              "KV": {
                "id": "<id>",
                "type": "kv",
              },
              "RANK_CHECK": {
                "exportName": "RankCheckWorkflow",
                "name": "every-acme-todo--rank-check",
                "type": "workflow",
                "worker": "every-acme-todo",
              },
              "USER_SYNC": {
                "exportName": "UserSyncDO",
                "type": "durable-object",
                "worker": "every-acme-todo",
              },
            },
            "exports": {
              "RankCheckWorkflow": {
                "name": "every-acme-todo--rank-check",
                "type": "workflow",
              },
              "UserSyncDO": {
                "storage": "sqlite",
                "type": "durable-object",
              },
            },
            "modules": {
              "assets/x.js.map": {
                "type": "sourcemap",
              },
            },
            "secrets": [
              "GATEWAY_URL",
              "EVERY_APP_ORG_ID",
            ],
            "workerName": "every-acme-todo",
          },
        ],
      }
    `);
  });
});

describe("apps with helper Workers", () => {
  const SEO: EveryAppCliManifest = {
    id: "seo",
    resources: {
      d1: ["DB"],
      durableObjects: [
        { name: "CHAT", className: "ChatAgent" },
        { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
      ],
      workflows: [
        { name: "RANK_CHECK", className: "RankCheckWorkflow" },
        { name: "SITE_AUDIT", className: "SiteAuditWorkflow", worker: "audit" },
      ],
    },
    workers: [{ name: "audit", binding: "AUDIT_ENGINE" }],
  };
  const HELPER = "every-acme-seo--audit";

  it("uploads each helper Worker before the app's, private and named after it", async () => {
    await deploy(SEO);

    const uploads = account.deploys.filter((upload) =>
      upload.workerName.startsWith("every-acme-seo"),
    );
    expect(uploads.map((upload) => upload.workerName)).toEqual([
      HELPER,
      "every-acme-seo",
    ]);
    const [helper, app] = uploads;
    expect(helper!.args).toEqual(expect.arrayContaining(["--worker", HELPER]));
    expect(app!.args).not.toContain("--worker");
    expect(helper!.config).toMatchObject({
      workersDev: false,
      previewUrls: false,
      env: {
        DB: { type: "d1", name: "every-acme-seo" },
        EVERY_APP_GATEWAY: {
          props: { appId: "seo", workerName: "every-acme-seo" },
        },
      },
      exports: {
        Scratchpad: { type: "durable-object" },
        SiteAuditWorkflow: { type: "workflow", name: "every-acme-seo--site-audit" },
      },
    });
    // The gateway and the organization reach both:
    // a helper's gateway calls are the organization's like the app's.
    for (const upload of [helper!, app!]) {
      expect(Object.keys(upload.secrets!).sort()).toEqual([
        "EVERY_APP_ORG_ID",
        "GATEWAY_URL",
      ]);
    }
    expect(helper!.secrets!["EVERY_APP_ORG_ID"]).toBe(app!.secrets!["EVERY_APP_ORG_ID"]);
    expect(app!.config["env"]).toMatchObject({
      AUDIT_ENGINE: { type: "worker", worker: HELPER },
      SCRATCHPAD: { type: "durable-object", worker: HELPER, exportName: "Scratchpad" },
      SITE_AUDIT: { type: "workflow", worker: HELPER },
    });
    // cf made each Workflow on the Worker that defines it.
    expect(account.workflows.get("every-acme-seo--site-audit")).toMatchObject({
      scriptName: HELPER,
      className: "SiteAuditWorkflow",
    });
    expect(account.workflows.get("every-acme-seo--rank-check")).toMatchObject({
      scriptName: "every-acme-seo",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.build",
        status: "ok",
        data: {
          release: false,
          workflows: ["every-acme-seo--rank-check", "every-acme-seo--site-audit"],
        },
      }),
    );
    // The gateway reaches only the app's Worker.
    expect(account.gatewayBindings()).toEqual(["every-acme-seo"]);
    await expect(readOwnedResources(registry(), "every-acme-seo")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "worker",
          binding: "audit",
          name: HELPER,
          versionId: account.workers.get(HELPER)!.versions.at(-1),
        }),
        expect.objectContaining({
          kind: "worker",
          binding: "",
          name: "every-acme-seo",
          versionId: account.workers.get("every-acme-seo")!.versions.at(-1),
        }),
      ]),
    );
    expect(appRow("seo")).toMatchObject({ status: "active" });
  });

  it("redeploys unattended, replacing the versions it recorded", async () => {
    await deploy(SEO);
    await deploy(SEO);
    expect(account.workers.get(HELPER)!.versions).toHaveLength(2);
    expect(account.workers.get("every-acme-seo")!.versions).toHaveLength(2);
  });

  it("refuses a helper Worker's name that something else already has", async () => {
    account.workers.set(HELPER, {
      versions: ["someone-elses"],
      config: {},
      secrets: {},
    });
    const before = account.deploys.length;
    await expect(deploy(SEO)).rejects.toMatchObject({ code: "WORKER_NAME_TAKEN" });
    expect(account.deploys.length).toBe(before);
  });

  it("refuses a helper's Workflow name another Worker runs, before uploading", async () => {
    account.workflows.set("every-acme-seo--site-audit", {
      scriptName: "billing-api",
      className: "Run",
      instances: new Map(),
    });
    const before = account.deploys.length;
    await expect(deploy(SEO)).rejects.toMatchObject({ code: "WORKFLOW_NAME_TAKEN" });
    expect(account.deploys.length).toBe(before);
  });

  it("refuses to move a Durable Object class between Workers or drop a helper's", async () => {
    await deploy(SEO);
    const moved: EveryAppCliManifest = {
      ...SEO,
      resources: {
        ...SEO.resources,
        durableObjects: [
          { name: "CHAT", className: "ChatAgent", worker: "audit" },
          { name: "SCRATCHPAD", className: "Scratchpad", worker: "audit" },
        ],
      },
    };
    await expect(deploy(moved)).rejects.toMatchObject({ code: "DURABLE_OBJECT_MOVED" });
    const dropped: EveryAppCliManifest = {
      ...SEO,
      resources: {
        ...SEO.resources,
        durableObjects: [{ name: "CHAT", className: "ChatAgent" }],
      },
    };
    await expect(
      deploy(dropped, { allowDeleteDurableObjectData: true }),
    ).rejects.toMatchObject({ code: "HELPER_DURABLE_OBJECT_REMOVED" });
  });

  it("deletes a helper's dropped Workflow only with --allow-delete-workflows", async () => {
    await deploy(SEO);
    const withoutAudit: EveryAppCliManifest = {
      ...SEO,
      resources: {
        ...SEO.resources,
        workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }],
      },
    };
    await expect(deploy(withoutAudit)).rejects.toMatchObject({ code: "WORKFLOW_REMOVED" });
    expect(account.workflows.has("every-acme-seo--site-audit")).toBe(true);

    await deploy(withoutAudit, { allowDeleteWorkflows: true });
    expect(account.workflows.has("every-acme-seo--site-audit")).toBe(false);
    expect(account.workflows.has("every-acme-seo--rank-check")).toBe(true);
  });

  it("warns that a helper Worker the manifest dropped keeps running", async () => {
    const plain: EveryAppCliManifest = { id: "seo", resources: { d1: ["DB"] } };
    await deploy({ ...plain, workers: [{ name: "audit" }] });
    await deploy(plain);
    expect(account.workers.has(HELPER)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "HELPER_WORKER_KEPT" }),
    );
  });

  it("starts a helper's Workflow by its binding", async () => {
    await deploy(SEO);
    fs.writeFileSync(
      path.join(appDir, "everyapp.config.ts"),
      `export default ${JSON.stringify(SEO)};\n`,
    );
    const options = { cwd: appDir, interactive: false, createCf: () => account.cf };
    await expect(
      startInstance({ ...options, workflow: "SITE_AUDIT", instanceId: "run-1" }),
    ).resolves.toMatchObject({ instance: { id: "run-1" } });
    expect((await listAppWorkflows(options)).workflows).toEqual([
      expect.objectContaining({ binding: "RANK_CHECK", deployed: true }),
      expect.objectContaining({
        binding: "SITE_AUDIT",
        name: "every-acme-seo--site-audit",
        deployed: true,
      }),
    ]);
  });

  it("purges the helper Workers and their Workflows with the app", async () => {
    await deploy(SEO);
    const result = await remove("seo", true);

    expect(account.workers.has("every-acme-seo")).toBe(false);
    expect(account.workers.has(HELPER)).toBe(false);
    expect([...account.workflows.keys()]).toEqual([]);
    expect(result.purged?.removed).toEqual(
      expect.arrayContaining([
        'Workflow "every-acme-seo--site-audit"',
        `Worker "${HELPER}"`,
      ]),
    );
    expect(result.purged?.kept).toEqual([]);
    await expect(readOwnedResources(registry(), "every-acme-seo")).resolves.toEqual([]);
  });
});

describe("workflows", () => {
  const options = () => ({
    cwd: appDir,
    interactive: false,
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
    ).resolves.toMatchObject({ instances: [{ id: "run-1", status: "paused" }] });

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
    expect((await listAppWorkflows(options())).workflows).toEqual([
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
    ).rejects.toMatchObject({
      code: "WORKFLOW_NOT_DEPLOYED",
      message: "RANK_CHECK is attached to another Worker\nCloudflare runs this Workflow on a Worker that isn't todo's.",
    });
    expect(account.workflows.get("every-acme-todo--rank-check")!.instances.size).toBe(0);
  });

  it("suggests the closest declared binding for one it doesn't know", async () => {
    const argv = process.argv;
    process.argv = ["node", "everyapp", "workflow", "instances", "RANK"];
    try {
      await expect(listInstances({ ...options(), workflow: "RANK" })).rejects.toMatchObject({
        code: "WORKFLOW_NOT_FOUND",
        message: "No Workflow RANK in everyapp.config.ts\nIt declares RANK_CHECK.",
        rerun: "pnpm everyapp workflow instances RANK_CHECK",
      });
    } finally {
      process.argv = argv;
    }
  });

  it("says the instance's status before asking to terminate it", async () => {
    await startInstance({ ...options(), workflow: "RANK_CHECK", instanceId: "run-1" });
    const confirm = vi.fn(async () => true);
    await changeInstanceStatus({
      ...options(),
      interactive: true,
      confirm,
      workflow: "RANK_CHECK",
      instanceId: "run-1",
      status: "terminate",
    });
    expect(confirm).toHaveBeenCalledWith("Terminate it? It stops for good.", [
      "RANK_CHECK instance run-1 is queued.",
    ]);
    expect(account.workflows.get("every-acme-todo--rank-check")!.instances.get("run-1")!.status).toBe(
      "terminated",
    );
  });

  it("lists nothing, without connecting, for an app that declares no Workflows", async () => {
    fs.writeFileSync(
      path.join(appDir, "everyapp.config.ts"),
      `export default ${JSON.stringify({ ...WITH_WORKFLOW, resources: { d1: ["DB"] } })};\n`,
    );
    const createCf = vi.fn(() => account.cf);
    await expect(listAppWorkflows({ ...options(), createCf })).resolves.toEqual({
      appId: "todo",
      workflows: [],
    });
    expect(createCf).not.toHaveBeenCalled();
    await expect(listInstances({ ...options(), workflow: "RANK_CHECK" })).rejects.toMatchObject({
      code: "NO_WORKFLOWS",
    });
  });
});

describe("deploy and delete with the gateway on a subdomain", () => {
  const GW = "apps.example.com";

  /** A new install: the gateway at apps.example.com in zone example.com. */
  beforeEach(async () => {
    account = new FakeCloudflare();
    worker = new GatewayWorker(account);
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
    account.apps.set(appDir, TODO);
    account.cf.calls.length = 0;
    events = [];
  });

  function deployHere(options: Partial<Parameters<typeof deployApp>[0]> = {}) {
    return deployApp({
      cwd: appDir,
      manifest: TODO,
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
      reconcile: rebind,
      live: live(),
      ...options,
    });
  }

  const cfCommands = () =>
    account.cf.calls.map((call) => call.args.slice(0, 3).join(" "));

  it("publishes a new app at <app>.<base> as its own Custom Domain, then waits for it to go live", async () => {
    worker.certificatePending.add(`todo.${GW}`);
    const live = {
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        // Cloudflare issues the certificate while the wait goes on.
        if (worker.requests.length === 1) worker.certificatePending.clear();
        return worker.fetch(input);
      }) as typeof fetch,
      sleep: async () => undefined,
    };

    const result = await deployHere({ live });

    expect(result).toMatchObject({
      liveUrl: `https://todo.${GW}`,
      hostname: `todo.${GW}`,
      workerName: "every-acme-todo",
    });
    expect(account.gatewayDomains()).toEqual([GW, `todo.${GW}`]);
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(appRow("todo")).toMatchObject({ status: "active" });
    await expect(readInstall(registry())).resolves.toMatchObject({
      liveDomains: [GW, `todo.${GW}`],
    });
    // Checked before anything was created or uploaded.
    const commands = cfCommands();
    const checked = commands.indexOf("dns records list");
    expect(checked).toBeGreaterThanOrEqual(0);
    expect(checked).toBeLessThan(commands.indexOf("d1 create --name"));
    expect(checked).toBeLessThan(commands.indexOf("build"));
    // It waited for the certificate, then the request made the app live.
    expect(worker.requests).toEqual([`https://todo.${GW}/`, `https://todo.${GW}/`]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "app.live",
        message: `Waiting for the certificate for todo.${GW} (usually under 5m)`,
      }),
    );
    // A person sees the wait end: the certificate came.
    expect(events.at(-1)).toMatchObject({
      type: "step",
      step: "app.live",
      status: "ok",
      data: { waited: "certificate" },
    });
  });

  it("redeploys an app's code without touching the gateway or its domains", async () => {
    await deployHere();
    const versions = gatewayVersions();
    account.cf.calls.length = 0;

    await deployHere();

    expect(gatewayVersions()).toBe(versions);
    expect(cfCommands()).not.toContain("dns records list");
    expect(worker.requests).toHaveLength(1);
  });

  it("never redeploys the gateway for a hostname it doesn't publish, outside the base", async () => {
    // A registry row from before, at a host that isn't one label below the base.
    account.database("every-app-gateway").sqlite.exec(`
      INSERT INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 0);
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

    // Bound already, and its host is never published: nothing to redeploy,
    // and nothing to wait for.
    expect(gatewayVersions()).toBe(versions);
    expect(cfCommands()).not.toContain("dns records list");
    expect(worker.requests).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "APP_HOST_OUTSIDE_BASE",
        message: expect.stringContaining("todo.example.com isn't one label below apps.example.com"),
      }),
    );

    // Deleting it leaves a certificate for that host alone: not the gateway's.
    account.certificatePacks.push({ id: "pack-site", zoneId: "zone-1", hosts: ["todo.example.com"] });
    await remove("todo", false);
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
      rerun: expect.stringContaining("--force-dns"),
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

  it("leaves the app to go live on its first visit with --no-wait, or once no certificate came in ten minutes", async () => {
    await expect(deployHere({ waitForLive: false })).resolves.toMatchObject({ live: false });
    expect(worker.requests).toEqual([]);
    expect(appRow("todo")).toMatchObject({ status: "binding" });
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.live",
        type: "step",
        status: "skip",
        data: expect.objectContaining({ url: `https://todo.${GW}`, reason: "certificate" }),
      }),
    );

    // A redeploy of an app that's live says so, waiting or not.
    await expect(deployHere()).resolves.toMatchObject({ live: true });
    events = [];
    await expect(deployHere({ waitForLive: false })).resolves.toMatchObject({ live: true });
    expect(events.find((event) => event["step"] === "app.live")).toMatchObject({ status: "ok" });

    // Another app whose certificate doesn't come in time: a warning, not a failure.
    events = [];
    const notes = { ...TODO, id: "notes", resources: { d1: ["DB"] } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
    otherDirs.push(dir);
    fs.writeFileSync(path.join(dir, "cloudflare.config.ts"), "everyAppWorker\n");
    account.apps.set(dir, notes);
    worker.certificatePending.add(`notes.${GW}`);
    await expect(
      deployHere({
        cwd: dir,
        manifest: notes,
        live: { fetch: worker.fetch, sleep: async () => undefined, maxWaitMs: 0 },
      }),
    ).resolves.toMatchObject({ hostname: `notes.${GW}`, live: false });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CERT_PENDING" }),
    );
  });

  it("removes a deleted app's hostname, and the certificate Cloudflare keeps for it", async () => {
    await deployHere();
    expect(account.certificatePacks.map((pack) => pack.hosts)).toContainEqual([
      "example.com",
      `todo.${GW}`,
      `*.todo.${GW}`,
    ]);

    await remove("todo", false);

    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.gatewayBindings()).toEqual([]);
    // The gateway's own pack lists the apex too, so the app's can go.
    expect(account.certificatePacks.map((pack) => pack.hosts)).toEqual([
      ["example.com", GW, `*.${GW}`],
    ]);
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

    await remove("todo", false);

    expect(appRow("todo")).toMatchObject({ status: "deleted" });
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CERT_CLEANUP_FAILED" }),
    );
  });
});

describe("delete", () => {
  beforeEach(async () => {
    await deploy();
  });

  it("deletes the app and drops its binding, keeping its Worker and data", async () => {
    await remove("todo", false);

    expect(appRow("todo")).toMatchObject({ status: "deleted" });
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.workers.has("every-acme-todo")).toBe(true);
    expect(account.namespaceId("every-acme-todo")).toBeTruthy();
    expect(events).toContainEqual(
      expect.objectContaining({ step: "app.delete", status: "ok", data: expect.objectContaining({ hostname: "todo.example.com" }) }),
    );
  });

  it("runs again after a delete that stopped before the gateway dropped the app", async () => {
    // The tombstone was written, then the run stopped.
    await deleteFromRegistry(registry(), "todo", { actor: "dev@example.com", email: "dev@example.com" });
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);

    await remove("todo", false);

    expect(account.gatewayBindings()).toEqual([]);
    expect(appRow("todo")).toMatchObject({ status: "deleted" });
  });

  it("refuses an app the registry doesn't have", async () => {
    await expect(remove("nope", false)).rejects.toMatchObject({
      code: "APP_NOT_FOUND",
      message: "No app named nope on this Gateway",
      rerun: "pnpm everyapp status",
    });
  });

  /** `delete` as a person sees it: stdout and stderr, colors stripped. */
  async function removeShown(appId: string, purge = false) {
    let text = "";
    const sink = createHumanSink({ write: (chunk) => (text += chunk), writeProblem: (chunk) => (text += chunk) });
    const result = await removeApp({
      appId,
      out: sink,
      interactive: false,
      purge,
      createCf: () => account.cf,
      reconcile: rebind,
    });
    sink.emit({ type: "done", ...deletionSummary(appId, result) });
    return stripVTControlCharacters(text);
  }

  it("says it removed the app, what stays, and how to delete that too", async () => {
    const shown = await removeShown("todo");

    expect(shown).toMatch(/^Removed todo from the Gateway ✓/m);
    expect(shown).not.toContain("Updating the Gateway");
    expect(shown).toMatch(
      /Its Worker and data are kept, and any cron triggers, Workflows and mail routes keep running\.\nTo delete those too: pnpm everyapp delete todo --purge\n$/,
    );
  });

  it("says an app deleted already was, without redeploying the Gateway", async () => {
    await remove("todo", false);
    const versions = gatewayVersions();

    const shown = await removeShown("todo");

    expect(gatewayVersions()).toBe(versions);
    expect(shown).toBe(
      "todo was already removed from the Gateway\nIts Worker and data are kept. To delete them: pnpm everyapp delete todo --purge\n",
    );
  });

  it("ticks the purge as its own step, naming the kinds it deleted", async () => {
    const shown = await removeShown("todo", true);

    expect(shown).toMatch(/^Removed todo from the Gateway ✓/m);
    expect(shown).toMatch(/^Deleted todo's Worker(, [\w ]+)* and [\w ]+ ✓/m);
    expect(shown).not.toContain("every-acme-todo");
  });

  it("brings a deleted app back under the same names on its next deploy", async () => {
    const before = appRow("todo")!;
    await remove("todo", false);

    await deploy();

    expect(appRow("todo")).toMatchObject({
      id: before["id"],
      worker_name: "every-acme-todo",
      hostname: "todo.example.com",
      status: "active",
    });
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
  });

  it("purges only what the app recorded, never what merely has its names", async () => {
    // App chef is registered, but its deploy never created anything: the
    // database with its name is someone else's.
    const chef: EveryAppCliManifest = { id: "chef", resources: { d1: ["DB"] } };
    const theirs = account.createDatabase("every-acme-chef");
    await expect(deployOther(chef)).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });

    const result = await remove("chef", true);

    expect(databaseId("every-acme-chef")).toBe(theirs.uuid);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "RESOURCES_KEPT",
        message:
          "Kept the D1 database every-acme-chef\nIt has chef's name, but no deploy recorded creating it, so it may belong to something else.",
        data: {
          kept: ['D1 database "every-acme-chef"'],
          fix: "if it is chef's, delete it in the Cloudflare dashboard (Storage & Databases → D1)",
        },
      }),
    );
    // Nothing was deleted, and the summary says so.
    expect(deletionSummary("chef", result)).toMatchObject({
      message: 'Deleted chef; kept D1 database "every-acme-chef".',
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

    const result = await remove("todo", true);

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
    const result = await remove("todo", true);

    expect(account.workers.has("every-acme-todo")).toBe(false);
    expect([...account.databases.values()].map((db) => db.name)).toEqual([
      "every-app-gateway",
    ]);
    expect(account.namespaceId("every-acme-todo")).toBeUndefined();
    await expect(readOwnedResources(registry(), "every-acme-todo")).resolves.toEqual([]);
    expect(deletionSummary("todo", result).data).toMatchObject({ purged: true, kept: [] });
  });
});

describe("deploy with no Gateway in the account yet", () => {
  beforeEach(() => {
    // GitHub Actions sets CI, which hides the owner link from `setup`;
    // these runs stand in for a person at a terminal.
    vi.stubEnv("CI", "");
    account = new FakeCloudflare();
    worker = new GatewayWorker(account);
  });

  /** setup's own seams, as `deploy` hands them on when it installs one. */
  const setupSeams = (opened: string[] = []) => ({
    prompts: {
      browserDeploymentToken: async () => null,
      pickZone: async (): Promise<string> => {
        throw new Error("asked which zone");
      },
      gatewayAddress: async (): Promise<string> => {
        throw new Error("asked for a hostname");
      },
    },
    // The person opens the owner link as soon as it shows.
    openBrowser: async (url: string) => {
      opened.push(url);
      worker.claim(url);
    },
    cliVersion: "0.3.0",
    seams: {
      ...seams,
      certificates: {
        probe: async () => ({ answered: true as const, status: 200, access: false }),
        sleep: async () => undefined,
      },
      fetch: worker.fetch,
      owner: { sleep: async () => undefined, timeoutMs: 60_000 },
    },
  });

  it("stops unattended with install_gateway, whose rerun is the setup command", async () => {
    const failure = await deploy(TODO, {
      json: true,
      interactive: false,
      offerInstall: {},
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      action: "install_gateway",
      rerun: "pnpm everyapp setup --domain apps.example.com",
      message: expect.stringContaining("Install a Gateway first: Acme has none yet"),
    });
    expect(account.deploys).toEqual([]);
    expect(account.databases.size).toBe(0);
  });

  it("offers one at apps.<zone> at a terminal, installs it with its owner, then deploys", async () => {
    const asked: string[] = [];
    const opened: string[] = [];

    const result = await deploy(TODO, {
      interactive: true,
      offerInstall: {
        confirm: async (question) => {
          asked.push(question);
          return true;
        },
        setup: setupSeams(opened),
      },
    });

    expect(asked).toEqual(["Install a Gateway at apps.example.com?"]);
    expect(opened).toEqual([expect.stringMatching(/^https:\/\/apps\.example\.com\/setup#token=est_/)]);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "setup.owner", status: "ok" }),
    );
    expect(result).toMatchObject({ liveUrl: "https://todo.apps.example.com", live: true });
    expect(account.gatewayDomains().sort()).toEqual(["apps.example.com", "todo.apps.example.com"]);
  });

  it("deploys nothing when the person declines: a cancel that names the setup command", async () => {
    const failure = await deploy(TODO, {
      interactive: true,
      offerInstall: { confirm: async () => false, setup: setupSeams() },
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: "CANCELLED",
      message:
        "Cancelled. Nothing deployed.\nApps deploy behind a Gateway. To install one elsewhere: pnpm everyapp setup --domain <hostname>",
    });
    expect(account.deploys).toEqual([]);
  });

  it("is GATEWAY_NOT_FOUND for the commands that don't offer to install", async () => {
    await expect(deploy(TODO, { interactive: true })).rejects.toMatchObject({
      code: "GATEWAY_NOT_FOUND",
    });
  });
});
