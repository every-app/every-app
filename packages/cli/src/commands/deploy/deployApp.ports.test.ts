/**
 * `everyapp deploy` of the two ports (Postiz and agentic-inbox), end to end
 * in the fake Cloudflare account (test/fakeCloudflare.ts), from their
 * manifests and cloudflare.config.ts as the ports plan writes them
 * (test/fixtures/manifests): register → provision → build → policy →
 * migrate → upload, the closest offline approximation of a first deploy.
 * The build is a double: the fake account's `cf build` evaluates each
 * port's Worker definitions with the SDK's real everyAppWorker() and
 * everyAppAuxiliaryWorker(), in place of the `vite build` Postiz's manifest
 * runs. Nothing here proves bundles, Workers AI or Email Routing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifestStrict } from "@every-app/perimeter/manifest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare, type FakeAppConfig } from "@/test/fakeCloudflare";
import { agenticInbox, agenticInboxConfig } from "@/test/fixtures/manifests/agentic-inbox";
import {
  POSTIZ_CRON,
  POSTIZ_FEATURES,
  POSTIZ_MIGRATIONS_DIR,
  postiz,
  postizConfig,
} from "@/test/fixtures/manifests/postiz";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const POSTIZ_WORKER = "every-acme-postiz";
const POSTIZ_API = "every-acme-postiz--api";
const PUBLISH_POST = "every-acme-postiz--publish-post";
const INBOX_WORKER = "every-acme-agentic-inbox";

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;
let installs: Array<string | false | undefined>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};

beforeEach(async () => {
  events = [];
  installs = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-port-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

/**
 * Deploy a port from its directory: its manifest (with the fake account's
 * `cf build` standing in for a `build` command) and its config double.
 */
function deploy(manifest: EveryAppCliManifest, config: FakeAppConfig) {
  const { build: _build, ...withCfBuild } = manifest;
  account.apps.set(appDir, withCfBuild);
  account.appConfigs.set(appDir, config);
  return deployApp({
    cwd: appDir,
    manifest: withCfBuild,
    out: out(),
    createCf: () => account.cf,
    installDeps: async ({ install }) => {
      installs.push(install);
    },
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const uploads = (prefix: string) =>
  account.deploys.filter((upload) => upload.workerName.startsWith(prefix));

/** Where each kind of cf call came in the run. */
const firstCall = (...prefix: string[]) =>
  account.cf.calls.findIndex((call) => prefix.every((arg, index) => call.args[index] === arg));

const appRow = (slug: string) =>
  account
    .database("every-app-gateway")
    .all("SELECT status, worker_name, version_id FROM apps WHERE app_slug = ?", slug)[0];

describe("deploy of Postiz (two Workers, D1 with d1-sql migrations, a Workflow and a cron)", () => {
  beforeEach(() => {
    fs.cpSync(POSTIZ_MIGRATIONS_DIR, path.join(appDir, "migrations"), { recursive: true });
  });

  it("validates as written, the build command included", () => {
    expect(validateManifestStrict(postiz)).toEqual(postiz);
    const sql = fs.readFileSync(path.join(POSTIZ_MIGRATIONS_DIR, "0001_init.sql"), "utf8");
    // The fixture's init: 9 statements, 8 markers between them.
    expect(sql.split("--> statement-breakpoint")).toHaveLength(9);
  });

  it("registers, provisions D1, builds, checks, migrates and uploads the helper before the app", async () => {
    const result = await deploy(postiz, postizConfig);

    expect(result).toMatchObject({ workerName: POSTIZ_WORKER, hostname: "postiz.example.com" });
    expect(appRow("postiz")).toMatchObject({ worker_name: POSTIZ_WORKER, status: "active" });
    expect(installs).toEqual(["pnpm install --frozen-lockfile"]);

    // Provision: one D1 database named after the Worker, recorded as the app's.
    const d1 = [...account.databases].find(([, db]) => db.name === POSTIZ_WORKER);
    expect(d1).toBeDefined();
    const owned = await readOwnedResources(registry(), POSTIZ_WORKER);
    expect(owned.map(({ kind, binding, name }) => ({ kind, binding, name }))).toEqual(
      expect.arrayContaining([
        { kind: "worker", binding: "", name: POSTIZ_WORKER },
        { kind: "worker", binding: "api", name: POSTIZ_API },
        { kind: "d1", binding: "DB", name: POSTIZ_WORKER },
      ]),
    );
    expect(account.namespaces.size).toBe(1); // the gateway's own
    expect(account.hyperdrive.size).toBe(0);

    // Policy: the build output passed with the helper's Workflow.
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.build",
        status: "ok",
        message: "Built the app and checked its Workers.",
        data: { release: false, workflows: [PUBLISH_POST] },
      }),
    );
    // The build was tenant-neutral; the deploy installed every placeholder.
    for (const upload of uploads(POSTIZ_WORKER)) {
      expect(JSON.stringify(upload.config)).not.toContain("sentinel");
    }

    // Migrate: the fixture's 9 statements on D1, before any upload.
    const db = account.database(POSTIZ_WORKER);
    expect(db.all("SELECT name FROM d1_migrations")).toEqual([{ name: "0001_init.sql" }]);
    const objects = db.all(
      "SELECT type, count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%' GROUP BY type ORDER BY type",
    );
    expect(objects).toEqual([
      { type: "index", n: 2 },
      { type: "table", n: 7 },
    ]);
    expect(firstCall("d1", "migrations", "apply")).toBeGreaterThan(-1);
    expect(firstCall("d1", "migrations", "apply")).toBeLessThan(firstCall("deploy"));
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.migrations",
        status: "ok",
        data: expect.objectContaining({ applied: ["0001_init.sql"] }),
      }),
    );
    // d1-sql has no drizzle schema to compare.
    expect(events.filter((event) => event["step"] === "app.schema")).toEqual([]);

    // Upload: the helper first, since the app binds it and its Workflow.
    expect(uploads(POSTIZ_WORKER).map((upload) => upload.workerName)).toEqual([
      POSTIZ_API,
      POSTIZ_WORKER,
    ]);
    expect(account.workflows.get(PUBLISH_POST)).toMatchObject({
      scriptName: POSTIZ_API,
      className: "PublishPostWorkflow",
    });
  });

  it("builds the helper with the Workflow, the cron, the CPU limit and the app's secrets left to `secret set`", async () => {
    await deploy(postiz, postizConfig);
    const [helper] = uploads(POSTIZ_WORKER);
    const config = helper!.config;

    expect(config).toMatchObject({
      name: POSTIZ_API,
      workersDev: false,
      previewUrls: false,
      triggers: [{ type: "scheduled", schedule: POSTIZ_CRON }],
      limits: { cpuMs: 300_000 },
      exports: { PublishPostWorkflow: { type: "workflow", name: PUBLISH_POST } },
    });
    expect(config["compatibilityFlags"]).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    const d1Id = [...account.databases].find(([, db]) => db.name === POSTIZ_WORKER)![0];
    expect(config["env"]).toMatchObject({
      DB: { type: "d1", name: POSTIZ_WORKER, id: d1Id },
      R2: { type: "r2", name: POSTIZ_WORKER },
      PUBLISH_POST: {
        type: "workflow",
        name: PUBLISH_POST,
        worker: POSTIZ_API,
        exportName: "PublishPostWorkflow",
      },
      EVERY_APP_GATEWAY: {
        type: "worker",
        worker: "every-app-gateway",
        exportName: "AppGateway",
        props: expect.objectContaining({ appId: "postiz", workerName: POSTIZ_WORKER }),
      },
      DATABASE_PROVIDER: { type: "text", value: "d1" },
      POSTIZ_FEATURES: { type: "json", value: POSTIZ_FEATURES },
      EVERYAPP_HEADER_AUTH: { type: "text", value: "true" },
    });
    // A production build declares none of the app's own secrets: `everyapp
    // secret set` puts them on the Worker after the first deploy. The
    // deploy's own two reach the helper as they reach the app's Worker.
    expect(
      Object.entries(config["env"]).filter(([, binding]: any) => binding.type === "secret"),
    ).toEqual([
      ["GATEWAY_URL", { type: "secret" }],
      ["EVERY_APP_ORG_ID", { type: "secret" }],
    ]);
    expect(Object.keys(helper!.secrets ?? {}).sort()).toEqual(["EVERY_APP_ORG_ID", "GATEWAY_URL"]);
  });

  it("builds the app Worker with its assets, the API service binding, the helper's Workflow and no cron", async () => {
    await deploy(postiz, postizConfig);
    const [, app] = uploads(POSTIZ_WORKER);
    const config = app!.config;

    expect(config).not.toHaveProperty("triggers");
    expect(config).not.toHaveProperty("limits");
    expect(config["exports"]).toEqual({});
    expect(config["assets"]).toEqual({
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    });
    expect(config["env"]).toMatchObject({
      EVERYAPP_AUDIENCE: { type: "text", value: POSTIZ_WORKER },
      API: { type: "worker", worker: POSTIZ_API },
      PUBLISH_POST: { type: "workflow", name: PUBLISH_POST, worker: POSTIZ_API },
      R2: { type: "r2", name: POSTIZ_WORKER },
      ASSETS: { type: "assets" },
      NEXT_PUBLIC_BACKEND_URL: { type: "text", value: "/api" },
      GATEWAY_URL: { type: "secret" },
      EVERY_APP_ORG_ID: { type: "secret" },
    });
    expect(Object.keys(app!.secrets ?? {}).sort()).toEqual(["EVERY_APP_ORG_ID", "GATEWAY_URL"]);
  });

  it("binds the bucket on both Workers from resources.r2, without the hand-written binding", async () => {
    const adopted = {
      ...postiz,
      resources: { ...postiz.resources, r2: ["R2"] },
    } satisfies EveryAppCliManifest;
    await deploy(adopted, postizConfig);

    for (const upload of uploads(POSTIZ_WORKER)) {
      expect(upload.config["env"]["R2"]).toEqual({ type: "r2", name: POSTIZ_WORKER });
    }
  });

  it("redeploys without creating or migrating anything again", async () => {
    await deploy(postiz, postizConfig);
    const databases = account.databases.size;
    events = [];

    await deploy(postiz, postizConfig);
    expect(account.databases.size).toBe(databases);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.migrations",
        status: "ok",
        message: "The app's database is up to date.",
      }),
    );
    expect(uploads(POSTIZ_WORKER).map((upload) => upload.workerName)).toEqual([
      POSTIZ_API,
      POSTIZ_WORKER,
      POSTIZ_API,
      POSTIZ_WORKER,
    ]);
  });

  it("refuses a bucket that isn't the app's before it migrates or uploads anything", async () => {
    account.editBuild = (config) => {
      config["env"]["MEDIA"] = { type: "r2", name: "company-media" };
    };
    await expect(deploy(postiz, postizConfig)).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining('MEDIA is bucket "company-media"'),
    });
    expect(uploads(POSTIZ_WORKER)).toEqual([]);
    expect(account.database(POSTIZ_WORKER).all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);
  });
});

describe("deploy of agentic-inbox (one Worker, two SQLite Durable Objects, no secrets)", () => {
  it("validates as written", () => {
    expect(validateManifestStrict(agenticInbox)).toEqual(agenticInbox);
  });

  it("registers, builds, checks and uploads one Worker, with nothing to provision or migrate", async () => {
    const databases = account.databases.size;
    const result = await deploy(agenticInbox, agenticInboxConfig);

    expect(result.workerName).toBe(INBOX_WORKER);
    expect(appRow("agentic-inbox")).toMatchObject({ worker_name: INBOX_WORKER, status: "active" });
    expect(account.databases.size).toBe(databases);
    expect(events.filter((event) => event["step"] === "app.migrations")).toEqual([]);

    const [upload, ...more] = uploads(INBOX_WORKER);
    expect(more).toEqual([]);
    expect(upload!.config).not.toHaveProperty("triggers");
    expect(upload!.config["exports"]).toEqual({
      MailboxDO: { type: "durable-object", storage: "sqlite" },
      EmailAgent: { type: "durable-object", storage: "sqlite" },
    });
    expect(upload!.config["env"]).toMatchObject({
      MAILBOX: { type: "durable-object", worker: INBOX_WORKER, exportName: "MailboxDO" },
      EMAIL_AGENT: { type: "durable-object", worker: INBOX_WORKER, exportName: "EmailAgent" },
      BUCKET: { type: "r2", name: INBOX_WORKER },
      EMAIL_ADDRESSES: { type: "json", value: [] },
      AI_PROVIDER: { type: "text", value: "workers-ai" },
      EVERYAPP_AUDIENCE: { type: "text", value: INBOX_WORKER },
    });
    const types = new Set(
      Object.values(upload!.config["env"]).map((binding: any) => String(binding.type)),
    );
    expect(types).not.toContain("ai");
    expect(types).not.toContain("send-email");
    expect(upload!.config["compatibilityFlags"]).toContain("nodejs_compat");
  });

  it.each([
    ["an ai binding", (config: Record<string, any>) => (config["env"]["AI"] = { type: "ai" })],
    [
      "a send-email binding",
      (config: Record<string, any>) => (config["env"]["EMAIL"] = { type: "send-email" }),
    ],
    [
      "an email trigger",
      (config: Record<string, any>) => (config["triggers"] = [{ type: "email" }]),
    ],
  ])("keeps refusing %s, before anything is uploaded", async (_case, edit) => {
    account.editBuild = edit;
    await expect(deploy(agenticInbox, agenticInboxConfig)).rejects.toMatchObject({
      code: "APP_POLICY",
    });
    expect(uploads(INBOX_WORKER)).toEqual([]);
  });
});
