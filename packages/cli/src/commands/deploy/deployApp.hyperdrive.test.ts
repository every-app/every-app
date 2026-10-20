/**
 * `everyapp deploy` and `delete --purge` of an app on Postgres, end to end
 * in the fake Cloudflare account (test/fakeCloudflare.ts): its Hyperdrive
 * config created (caching off unless the manifest says otherwise), adopted
 * or repointed from the app's secrets file, bound to its Workers with
 * DATABASE_PROVIDER, placement and CPU limits, its migrations run by a stub
 * drizzle-kit (or Prisma CLI, migrations.engine "prisma") before the
 * upload, and the config deleted with the app.
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
import type { MigrationCliRunner } from "@/lib/migrations/localCli";
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
/** What the stub drizzle-kit (or Prisma CLI) was asked, and how many uploads had happened. */
let migrations: Array<{ args: string[]; env: Record<string, string>; uploadsBefore: number }>;
let prismaMigrations: typeof migrations;
let migrationResult: Awaited<ReturnType<MigrationCliRunner>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};
const drizzleKit: MigrationCliRunner = async ({ args, env }) => {
  migrations.push({ args, env, uploadsBefore: seoUploads().length });
  return migrationResult;
};
const prisma: MigrationCliRunner = async ({ args, env }) => {
  prismaMigrations.push({ args, env, uploadsBefore: seoUploads().length });
  return migrationResult;
};

beforeEach(async () => {
  events = [];
  migrations = [];
  prismaMigrations = [];
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
    prisma,
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
    // Nor in the Workers it built.
    for (const upload of account.deploys) {
      expect(JSON.stringify(upload.config)).not.toContain(PASSWORD);
    }
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
      fix: expect.stringContaining("HYPERDRIVE_ORIGIN_URL"),
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

  it("creates no Hyperdrive for an app on the dispatch tier, which a CLI deploy refuses outright", async () => {
    const { migrations: _m, database: _d, ...plain } = SEO;
    await deploy({ ...plain, resources: { kv: ["KV"] } });
    account
      .database("every-app-gateway")
      .all("UPDATE apps SET tier = 'dispatch' WHERE app_slug = 'seo'");
    const uploads = seoUploads().length;

    // Registration refuses the tier change before the Hyperdrive policy
    // (manifest.test.ts covers the per-tier config limit) is even consulted.
    await expect(deploy()).rejects.toMatchObject({
      code: "APP_TIER_MISMATCH",
      message: expect.stringContaining("hosted deploy API"),
    });
    expect(account.hyperdrive.size).toBe(0);
    expect(seoUploads()).toHaveLength(uploads);
  });

  it("creates the config with query caching off, and keeps it off when it is repointed", async () => {
    await deploy();
    expect(JSON.parse(hyperdriveCalls("create")[0]!.files["hyperdrive.json"]!)).toMatchObject({
      name: CONFIG,
      caching: { disabled: true },
    });
    expect(account.hyperdriveConfig(CONFIG)!.caching).toEqual({ disabled: true });

    writeSecrets(`POSTGRES_DATABASE_URL=postgres://openseo:${PASSWORD}@db2.example.net:5432/openseo\n`);
    await deploy();
    expect(JSON.parse(hyperdriveCalls("update")[0]!.files["hyperdrive.json"]!)).toEqual({
      origin: expect.objectContaining({ host: "db2.example.net" }),
      caching: { disabled: true },
    });
    // Only the origin changed, so only that is said.
    expect(events.filter((event) => /caching/.test(String(event["message"])))).toEqual([]);
  });

  it("turns caching back off on a config that caches, and on for caching \"default\"", async () => {
    await deploy();
    const { id } = account.hyperdriveConfig(CONFIG)!;
    // Someone turned caching on in the dashboard.
    account.hyperdrive.set(id, { ...account.hyperdrive.get(id)!, caching: { disabled: false } });

    events = [];
    await deploy();
    expect(account.hyperdriveConfig(CONFIG)!.caching).toEqual({ disabled: true });
    expect(JSON.parse(hyperdriveCalls("update")[0]!.files["hyperdrive.json"]!)).toEqual({
      caching: { disabled: true },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.resources",
        message: expect.stringMatching(/^Turned off query caching on Hyperdrive config/),
      }),
    );

    const cached: EveryAppCliManifest = {
      ...SEO,
      resources: { kv: ["KV"], hyperdrive: [{ name: "HYPERDRIVE", caching: "default" }] },
    };
    await deploy(cached);
    expect(account.hyperdriveConfig(CONFIG)!.caching).toEqual({ disabled: false });
    expect(JSON.parse(hyperdriveCalls("update")[1]!.files["hyperdrive.json"]!)).toEqual({
      caching: { disabled: false },
    });
    // In step: nothing more to change.
    await deploy(cached);
    expect(hyperdriveCalls("update")).toHaveLength(2);
  });

  it("creates a config for caching \"default\" without a caching setting, as Cloudflare's own", async () => {
    await deploy({
      ...SEO,
      resources: { kv: ["KV"], hyperdrive: [{ name: "HYPERDRIVE", caching: "default" }] },
    });
    const body = JSON.parse(hyperdriveCalls("create")[0]!.files["hyperdrive.json"]!);
    expect(body).not.toHaveProperty("caching");
    expect(hyperdriveCalls("update")).toHaveLength(0);
  });

  it("turns caching off on a config it adopts", async () => {
    account.hyperdrive.set("adopted", {
      name: CONFIG,
      origin: { scheme: "postgres", host: "db.example.net", port: 6432, database: "openseo", user: "openseo" },
      password: PASSWORD,
    });
    await deploy();
    expect(account.hyperdriveConfig(CONFIG)).toMatchObject({ id: "adopted", caching: { disabled: true } });
  });

  describe('on the "prisma" engine', () => {
    const PRISMA: EveryAppCliManifest = {
      ...SEO,
      migrations: { engine: "prisma", dialect: "postgresql", config: "prisma.config.ts" },
    };

    it("runs prisma migrate deploy with the URL in its environment, before anything is uploaded", async () => {
      migrationResult = {
        exitCode: 0,
        stdout: "1 migration found in prisma/migrations\n\nApplying migration `20240101_init`\n",
        stderr: "",
      };
      await deploy(PRISMA);

      expect(prismaMigrations).toEqual([
        {
          args: ["migrate", "deploy", "--config", "prisma.config.ts"],
          env: { POSTGRES_DATABASE_URL: DATABASE_URL },
          uploadsBefore: 0,
        },
      ]);
      expect(migrations).toEqual([]);
      expect(seoUploads()).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({
          step: "app.migrations",
          status: "ok",
          message: "Migrated the app's Postgres database (prisma migrate deploy).",
          data: { dialect: "postgresql", engine: "prisma", applied: ["20240101_init"] },
        }),
      );
    });

    it("says, without a warning, that it can't check the schema against the migrations, and why", async () => {
      await deploy(PRISMA);
      expect(events.filter((event) => event["step"] === "app.schema")).toEqual([
        expect.objectContaining({ type: "progress", message: expect.stringContaining("prisma migrate diff") }),
        expect.objectContaining({
          type: "step",
          status: "skip",
          message: expect.stringContaining("shadow database"),
        }),
      ]);
    });

    it("leaves the migrations' place to Prisma's config, unless the manifest names a dir that's missing", async () => {
      // No drizzle/ directory is needed: Prisma knows where its migrations are.
      fs.rmSync(path.join(appDir, "drizzle"), { recursive: true });
      await deploy(PRISMA);
      expect(prismaMigrations).toHaveLength(1);

      await deploy({ ...PRISMA, migrations: { ...PRISMA.migrations!, dir: "prisma/migrations" } });
      expect(prismaMigrations).toHaveLength(1);
      expect(events).toContainEqual(
        expect.objectContaining({ step: "app.migrations", status: "skip" }),
      );
    });

    it("stops on a failed migration without uploading, and never repeats the password", async () => {
      migrationResult = {
        exitCode: 1,
        stdout: `Datasource "db": PostgreSQL database "openseo" at "${DATABASE_URL}"`,
        stderr: `Error: P1000: Authentication failed against database server, the provided database credentials for \`openseo\` (${PASSWORD}) are not valid.`,
      };
      await expect(deploy(PRISMA)).rejects.toMatchObject({
        code: "MIGRATION_FAILED",
        message: expect.stringContaining("Error: P1000: Authentication failed"),
      });
      expect(JSON.stringify(events)).not.toContain(PASSWORD);
      await expect(deploy(PRISMA)).rejects.toMatchObject({
        message: expect.not.stringContaining(PASSWORD),
      });
      expect(seoUploads()).toEqual([]);
    });
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
