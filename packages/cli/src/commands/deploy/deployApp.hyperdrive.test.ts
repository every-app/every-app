/**
 * `everyapp deploy` and `delete --purge` of an app on Postgres, end to end
 * in the fake Cloudflare account (test/fakeCloudflare.ts): its Hyperdrive
 * config created, adopted or repointed from the app's secrets file, bound
 * to its Workers with DATABASE_PROVIDER, placement and CPU limits, its
 * migrations run by a stub drizzle-kit before the upload, and the config
 * deleted with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import type { DrizzleKitRunner } from "@/lib/migrations/postgres";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const PASSWORD = "s3cret-pa55";
const DATABASE_URL = `postgres://openseo:${PASSWORD}@db.example.net:6432/openseo`;
const CONFIG = "every-acme-seo--hyperdrive";
const HELPER = "every-acme-seo--audit";

const SEO: EveryAppCliManifest = {
  id: "seo",
  resources: { kv: ["KV"], hyperdrive: [{ name: "HYPERDRIVE" }] },
  workers: [{ name: "audit", binding: "AUDIT_ENGINE", limits: { cpuMs: 300_000 } }],
  database: { provider: "postgres", region: "aws:us-east-1" },
  limits: { cpuMs: 30_000 },
  migrations: {
    engine: "drizzle",
    dialect: "postgresql",
    dir: "drizzle/pg",
    config: "drizzle/pg.config.ts",
  },
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;
/** What the stub drizzle-kit was asked, and how many uploads had happened. */
let migrations: Array<{ args: string[]; env: Record<string, string>; uploadsBefore: number }>;
let migrationResult: Awaited<ReturnType<DrizzleKitRunner>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};
const drizzleKit: DrizzleKitRunner = async ({ args, env }) => {
  migrations.push({ args, env, uploadsBefore: seoUploads().length });
  return migrationResult;
};

beforeEach(async () => {
  events = [];
  migrations = [];
  migrationResult = { exitCode: 0, stdout: "[✓] migrations applied successfully!", stderr: "" };
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

  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-pg-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "pg"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "drizzle", "pg", "0000_init.sql"),
    "CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL);",
  );
  writeSecrets(`POSTGRES_DATABASE_URL=${DATABASE_URL}\n`);
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function writeSecrets(content: string) {
  fs.mkdirSync(path.join(appDir, ".everyapp"), { recursive: true });
  fs.writeFileSync(path.join(appDir, ".everyapp", "secrets.env"), content);
}

function deploy(manifest: EveryAppCliManifest = SEO) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    drizzleKit,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const hyperdriveCalls = (action: string) =>
  account.cf.calls.filter((call) => call.args[0] === "hyperdrive" && call.args[1] === action);

const seoUploads = () =>
  account.deploys.filter((upload) => upload.workerName.startsWith("every-acme-seo"));

describe("deploy of an app on Postgres through Hyperdrive", () => {
  it("creates the config from the secrets file and binds it on every Worker", async () => {
    await deploy();

    const config = account.hyperdriveConfig(CONFIG)!;
    expect(config).toMatchObject({
      origin: {
        scheme: "postgres",
        host: "db.example.net",
        port: 6432,
        database: "openseo",
        user: "openseo",
      },
      password: PASSWORD,
    });
    const [helper, app] = seoUploads();
    expect(helper!.workerName).toBe(HELPER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]).toMatchObject({
        HYPERDRIVE: { type: "hyperdrive", id: config.id },
        DATABASE_PROVIDER: { type: "text", value: "postgres" },
      });
      expect(upload.config["placement"]).toEqual({ region: "aws:us-east-1" });
    }
    expect(helper!.config["limits"]).toEqual({ cpuMs: 300_000 });
    expect(app!.config["limits"]).toEqual({ cpuMs: 30_000 });
    await expect(readOwnedResources(registry(), "every-acme-seo")).resolves.toContainEqual(
      expect.objectContaining({
        kind: "hyperdrive",
        binding: "HYPERDRIVE",
        name: CONFIG,
        resourceId: config.id,
      }),
    );
  });

  it("migrates Postgres with the app's drizzle-kit before anything is uploaded", async () => {
    await deploy();

    expect(migrations).toEqual([
      {
        args: ["migrate", "--config", "drizzle/pg.config.ts"],
        env: { POSTGRES_DATABASE_URL: DATABASE_URL },
        uploadsBefore: 0,
      },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "app.migrations", status: "ok" }),
    );
  });

  it("never puts the database password on a command line or in its output", async () => {
    await deploy();

    expect(hyperdriveCalls("create")).toHaveLength(1);
    for (const call of account.cf.calls) {
      expect(call.args.join(" ")).not.toContain(PASSWORD);
    }
    expect(hyperdriveCalls("create")[0]!.files["hyperdrive.json"]).toContain(PASSWORD);
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
    // The deploy inputs the build read are gone, and never held it.
    expect(fs.existsSync(path.join(appDir, ".everyapp", "deploy.json"))).toBe(false);
    expect(fs.readFileSync(path.join(appDir, ".gitignore"), "utf8")).toContain(".everyapp/");
  });

  it("keeps the config on a redeploy, and points it at a database that moved", async () => {
    await deploy();
    const { id } = account.hyperdriveConfig(CONFIG)!;
    await deploy();
    expect(hyperdriveCalls("create")).toHaveLength(1);
    expect(hyperdriveCalls("update")).toHaveLength(0);

    writeSecrets(
      `POSTGRES_DATABASE_URL=postgres://openseo:${PASSWORD}2@db2.example.net:5432/openseo\n`,
    );
    await deploy();
    expect(account.hyperdriveConfig(CONFIG)).toMatchObject({
      id,
      origin: { host: "db2.example.net", port: 5432 },
      password: `${PASSWORD}2`,
    });
    expect(hyperdriveCalls("update")[0]!.args).toEqual([
      "hyperdrive",
      "update",
      id,
      "--body",
      "@/fake-cf-files/hyperdrive.json",
    ]);
  });

  it("adopts a config of its name that connects to the database in the secrets file", async () => {
    await account.cf.run({
      plane: "account",
      mode: "json",
      files: {
        "hyperdrive.json": {
          name: CONFIG,
          origin: {
            scheme: "postgres",
            host: "db.example.net",
            port: 6432,
            database: "openseo",
            user: "openseo",
            password: PASSWORD,
          },
        },
      },
      args: (files) => ["hyperdrive", "create", "--body", `@${files["hyperdrive.json"]!}`],
    });
    const { id } = account.hyperdriveConfig(CONFIG)!;

    await deploy();
    expect(seoUploads()[1]!.config["env"].HYPERDRIVE).toEqual({ type: "hyperdrive", id });
    expect(events).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/^Adopted Hyperdrive config/) }),
    );
  });

  it("refuses a config of its name that connects elsewhere, before anything is uploaded", async () => {
    account.hyperdrive.set("someone-elses", {
      name: CONFIG,
      origin: { scheme: "postgres", host: "other.example.net", port: 5432, database: "x", user: "x" },
      password: "theirs",
    });

    await expect(deploy()).rejects.toMatchObject({ code: "RESOURCE_NAME_TAKEN" });
    expect(seoUploads()).toEqual([]);
    expect(migrations).toEqual([]);
  });

  it("names the variable to set when there's no origin, before anything is created", async () => {
    writeSecrets("");
    await expect(deploy()).rejects.toMatchObject({ code: "POSTGRES_URL_MISSING" });

    const { migrations: _none, ...withoutMigrations } = SEO;
    await expect(
      deploy({ ...withoutMigrations, database: { provider: "postgres" } }),
    ).rejects.toMatchObject({
      code: "HYPERDRIVE_ORIGIN_MISSING",
      message: expect.stringContaining("HYPERDRIVE_ORIGIN_URL"),
    });
    expect(account.hyperdrive.size).toBe(0);
    expect(seoUploads()).toEqual([]);
  });

  it("prefers a binding's own origin over POSTGRES_DATABASE_URL", async () => {
    writeSecrets(
      [
        `POSTGRES_DATABASE_URL=${DATABASE_URL}`,
        `HYPERDRIVE_ORIGIN_URL=postgres://app_rw:${PASSWORD}@db.example.net:6432/openseo`,
        "",
      ].join("\n"),
    );
    await deploy();
    expect(account.hyperdriveConfig(CONFIG)!.origin.user).toBe("app_rw");
    expect(migrations[0]!.env).toEqual({ POSTGRES_DATABASE_URL: DATABASE_URL });
  });

  it("stops on a failed migration without uploading, and never repeats the password", async () => {
    migrationResult = {
      exitCode: 1,
      stdout: "",
      stderr: `Error: password authentication failed for ${DATABASE_URL} (${PASSWORD})`,
    };
    await expect(deploy()).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.not.stringContaining(PASSWORD),
    });
    expect(seoUploads()).toEqual([]);
  });

  it("refuses Hyperdrive for an app on the dispatch tier", async () => {
    const { migrations: _m, database: _d, ...plain } = SEO;
    await deploy({ ...plain, resources: { kv: ["KV"] } });
    account
      .database("every-app-gateway")
      .all("UPDATE apps SET tier = 'dispatch' WHERE app_slug = 'seo'");
    const uploads = seoUploads().length;

    await expect(deploy()).rejects.toMatchObject({
      code: "TIER_POLICY",
      message: expect.stringContaining("at most 25 configs"),
    });
    expect(account.hyperdrive.size).toBe(0);
    expect(seoUploads()).toHaveLength(uploads);
  });

  it("deletes the config with the app on --purge, and leaves the database alone", async () => {
    await deploy();
    const result = await removeApp({
      appId: "seo",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });

    expect(account.hyperdrive.size).toBe(0);
    expect(result.purged?.removed).toContain(`Hyperdrive config "${CONFIG}"`);
    expect(result.purged?.kept).toEqual([]);
    expect(hyperdriveCalls("delete")[0]!.args).toContain("--force");
  });
});
