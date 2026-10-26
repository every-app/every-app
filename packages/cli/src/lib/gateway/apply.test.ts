/**
 * `everyapp setup` end to end, against a fake
 * Cloudflare account: real gateway migrations on SQLite, Build Outputs
 * validated with cf's schema, nothing spawned or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { rollbackFor } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { createNdjsonSink } from "@/lib/output/events";
import {
  ACCOUNT_ID,
  customDomainsSkipped,
  FakeCloudflare,
} from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { loseLeaseAtCheck, OTHER_HOLDER } from "@/test/loseLease";
import { handleInterrupt, resetInterruptsForTests } from "@/lib/interrupt";
import { applyGateway } from "./apply";
import { readInstall, writeInstall } from "./install";
import { holdLease } from "@/test/holdLease";
import { LeasePurpose } from "./lease";
import { reconcileGateway } from "./reconcile";
import { openRelease, type GatewayRelease } from "./release";
import { ensureGatewayResources } from "./resources";
import { readRestorePoint } from "./restorePoints";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let events: Array<Record<string, any>>;
let home: string;

const out = () =>
  createNdjsonSink((line) => events.push(JSON.parse(line)));
const noSleep = async () => undefined;

beforeEach(async () => {
  account = new FakeCloudflare();
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function deployGateway(
  options: Partial<Parameters<typeof applyGateway>[0]> = {},
) {
  const resources = await ensureGatewayResources(account.cf);
  return applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: "example.com",
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: options.gatewayHost ?? "example.com",
    resources,
    db: cfD1Database(account.cf, [...account.databases][0]![0]),
    interactive: false,
    cliVersion: "0.3.0",
    sleep: noSleep,
    leaseWaitMs: 0,
    ...options,
  });
}

/**
 * A reconcile, which deploys the release this checkout builds: here
 * `tarball`, the one the gateway was installed with, unless a test says.
 */
function reconcile(options: Partial<Parameters<typeof reconcileGateway>[0]> = {}) {
  return reconcileGateway({
    cf: account.cf,
    out: out(),
    accountId: ACCOUNT_ID,
    databaseId: gatewayDatabaseId(),
    openRelease: () => openRelease(tarball),
    interactive: false,
    cliVersion: "0.3.0",
    sleep: noSleep,
    leaseWaitMs: 0,
    ...options,
  });
}

const gatewayDb = () => account.database("every-app-gateway");
const gatewayDatabaseId = () =>
  [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0];
const gatewayD1 = () => cfD1Database(account.cf, gatewayDatabaseId());

/** A later build of the same gateway version, as a newer CLI bundles it. */
const laterBuild = async () =>
  openRelease(
    await buildGatewayRelease({ version: "0.2.0", builtAt: "2026-10-13T00:00:00.000Z" }),
  );

/** Rows the registry would hold for these apps, with their Workers uploaded. */
function seedApps(
  rows: Array<{
    slug: string;
    worker: string;
    status: string;
    /** Its Worker was never uploaded, or was deleted by hand. */
    missing?: boolean;
    /** Default: `<slug>.example.com`, one label below the default install's base. */
    hostname?: string;
  }>,
): void {
  const db = gatewayDb().sqlite;
  db.exec(`
    INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES ('org-1', 'Acme', 'acme', 0);
    INSERT OR IGNORE INTO organization_keys (organization_id, org_key) VALUES ('org-1', 'acme');
  `);
  for (const row of rows) {
    db.prepare(
      "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status) VALUES (?, 'org-1', ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `row-${row.slug}`,
      row.slug,
      row.slug,
      row.slug,
      row.hostname ?? `${row.slug}.example.com`,
      row.worker,
      JSON.stringify({ id: row.slug }),
      row.status,
    );
    if (!row.missing) {
      account.workers.set(row.worker, {
        versions: [`${row.worker}-v1`],
        config: { name: row.worker, env: {} },
        secrets: {},
      });
    }
  }
}

describe("applyGateway", () => {
  it("installs a gateway: migrations first, then one upload with its secrets", async () => {
    const result = await deployGateway();

    // The order that keeps a failure safe: lease and migrations
    // all before the upload. Nothing is kept in KV.
    const commands = account.cf.calls.map((call) => call.args.slice(0, 3).join(" "));
    const order = [
      "d1 query", // the lease (and its table)
      "d1 migrations list",
      "d1 migrations apply",
      "deploy --prebuilt --no-provision",
    ].map((command) => commands.findIndex((c) => c.startsWith(command)));
    expect(order.every((index, i) => i === 0 || index > order[i - 1]!)).toBe(true);
    expect(commands.some((command) => command.startsWith("kv keys"))).toBe(false);
    expect(account.namespaces.size).toBe(1);

    const [deploy] = account.deploys;
    expect(account.deploys).toHaveLength(1);
    expect(deploy!.config["env"]).toMatchObject({
      DB: { type: "d1", name: "every-app-gateway", id: [...account.databases][0]![0] },
      OAUTH_KV: { type: "kv", id: account.namespaceId("every-app-gateway-OAUTH_KV") },
      EVERYAPP_RELEASE: {
        type: "json",
        value: { version: "0.2.0", sha256: release.manifest.sha256 },
      },
    });
    // Its host is a Custom Domain; apps will be too, one label below it.
    expect(deploy!.config["domains"]).toEqual(["example.com"]);
    // No route: only the release's own hourly housekeeping.
    expect(deploy!.config["triggers"]).toEqual([
      { type: "scheduled", schedule: "17 * * * *" },
    ]);
    expect(deploy!.config["env"].APP_BASE_DOMAIN).toEqual({
      type: "text",
      value: "example.com",
    });
    expect(account.gatewayBindings()).toEqual([]);

    // A first deploy sends the generated secrets in a private file, with the
    // upload; none of them is on the command line.
    expect(Object.keys(deploy!.secrets!).sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "CLOUDFLARE_ACCOUNT_ID",
      "GATEWAY_DEPLOYMENT_MODE",
      "GATEWAY_URL",
      "JWT_PRIVATE_KEY",
      "JWT_PUBLIC_KEY",
    ]);
    expect(deploy!.secrets).toMatchObject({
      GATEWAY_URL: "https://example.com",
      GATEWAY_DEPLOYMENT_MODE: "self_hosted",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    });
    expect(deploy!.args).toContain("--secrets-file");
    for (const value of Object.values(deploy!.secrets!)) {
      expect(deploy!.args.join(" ")).not.toContain(value);
    }

    expect(result).toMatchObject({
      firstDeploy: true,
      appWorkers: [],
      domains: ["example.com"],
      newHosts: ["example.com"],
    });
    const db = gatewayDb();
    expect(db.all("SELECT COUNT(*) AS n FROM d1_migrations")[0]!["n"]).toBe(
      release.manifest.migrations.length,
    );
    // The lease is free again, and the install is recorded.
    expect(db.all("SELECT * FROM _everyapp_deploy_lease")).toEqual([]);
    // With the public half of the identity key, which the apps' deploys hand their
    // Workers: the CLI keeps neither half.
    await expect(readInstall(cfD1Database(account.cf, [...account.databases][0]![0]))).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      gatewayHost: "example.com",
      zoneId: "zone-1",
      appBaseDomain: "example.com",
      liveDomains: ["example.com"],
      releaseSha256: release.manifest.sha256,
      liveVersionId: account.workers.get("every-app-gateway")!.versions[0],
      jwtPublicKey: deploy!.secrets!["JWT_PUBLIC_KEY"],
    });
    expect(deploy!.secrets!["JWT_PUBLIC_KEY"]).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    // Nothing about the install is kept on this machine.
    expect(fs.readdirSync(path.join(home, ".everyapp"))).toEqual(["cf"]);
  });

  it("records a new install before anything can stop it, so a resume needs no --domain", async () => {
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;

    await expect(deployGateway({ gatewayHost: "apps.example.com" })).rejects.toMatchObject({
      action: "register_workers_subdomain",
    });

    // Where it goes, and nothing live yet.
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      gatewayHost: "apps.example.com",
      zoneName: "example.com",
      appBaseDomain: "apps.example.com",
      releaseSha256: release.manifest.sha256,
      liveVersionId: null,
      liveDomains: [],
      jwtPublicKey: null,
    });

    // The resume migrates and uploads, and records the key it generated.
    await deployGateway({ gatewayHost: "apps.example.com" });
    const row = (await readInstall(gatewayD1()))!;
    expect(row.liveVersionId).toBe(account.workers.get("every-app-gateway")!.versions[0]);
    expect(row.jwtPublicKey).toBe(account.deploys.at(-1)!.secrets!["JWT_PUBLIC_KEY"]);
  });

  it("redeploys without secrets, keeping the identity key it recorded", async () => {
    await deployGateway();
    const key = (await readInstall(gatewayD1()))!.jwtPublicKey;
    const result = await deployGateway();

    expect(account.deploys).toHaveLength(2);
    expect(account.deploys[1]!.secrets).toBeNull();
    expect(result).toMatchObject({ firstDeploy: false });
    expect((await readInstall(gatewayD1()))!.jwtPublicKey).toBe(key);
    // What went live is the record: nothing was asked of the gateway.
    expect(account.cf.calls.every((call) => !call.args.join(" ").includes("https://"))).toBe(true);
  });

  it("records the public half of every new key pair it sends, as when the Worker was deleted and comes back", async () => {
    await deployGateway({ deploymentMode: "hosted" });
    const before = (await readInstall(gatewayD1()))!.jwtPublicKey;
    // The gateway Worker deleted by hand: the next deploy sets a new pair.
    account.workers.delete("every-app-gateway");

    // As a repair or a reconcile deploys it: no mode asked for.
    await deployGateway();

    const sent = account.deploys.at(-1)!.secrets!["JWT_PUBLIC_KEY"];
    expect(sent).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(sent).not.toBe(before);
    expect((await readInstall(gatewayD1()))!.jwtPublicKey).toBe(sent);
    // The mode it was installed with comes back with it.
    expect(account.deploys.at(-1)!.secrets).toMatchObject({
      GATEWAY_DEPLOYMENT_MODE: "hosted",
    });
    expect((await readInstall(gatewayD1()))!.deploymentMode).toBe("hosted");
  });

  it("deploys once, even when an app registers meanwhile: that app's own rebind binds it", async () => {
    await deployGateway();
    const deploys = account.deploys.length;
    // An app's deploy marks the app as deployed while this upload runs.
    account.afterUpload = (worker) => {
      if (worker !== "every-app-gateway") return undefined;
      account.afterUpload = null;
      seedApps([{ slug: "todo", worker: "every-acme-todo", status: "binding" }]);
      return undefined;
    };

    await deployGateway({ reason: "upgrade" });

    expect(account.deploys).toHaveLength(deploys + 1);
    expect(account.gatewayBindings()).toEqual([]);
    // Its rebind, once this deploy freed the lease.
    await expect(reconcile({ force: true })).resolves.toMatchObject({
      appWorkers: ["every-acme-todo"],
    });
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
  });

  it("leaves the gateway that is serving alone when a migration fails", async () => {
    await deployGateway();
    const serving = account.workers.get("every-app-gateway")!.versions;
    await release.cleanup();
    release = await openRelease(
      await buildGatewayRelease({
        version: "0.3.0",
        extraMigration: { file: "9999_broken.sql", sql: "ALTER TABLE nope ADD x text;" },
      }),
    );

    await expect(deployGateway({ reason: "upgrade" })).rejects.toMatchObject({
      code: "MIGRATION_FAILED",
      message: expect.stringContaining(`${CLI} db restore --gateway`),
      data: { rollbackCommand: expect.stringContaining("d1 time-travel restore") },
    });
    // Recorded before the migration ran: `db restore --gateway` finds it.
    await expect(readRestorePoint(gatewayDb(), "gateway")).resolves.toMatchObject({
      migrations: ["9999_broken.sql"],
      createdBy: "dev@example.com",
    });
    expect(account.deploys).toHaveLength(1);
    expect(account.workers.get("every-app-gateway")!.versions).toEqual(serving);
    expect(gatewayDb().all("SELECT * FROM _everyapp_deploy_lease")).toEqual([]);
  });

  it("waits for, and then gives up on, a deploy that holds the lease, and goes once it expires", async () => {
    await ensureGatewayResources(account.cf);
    gatewayDb().sqlite.exec(`
      CREATE TABLE _everyapp_deploy_lease (id TEXT PRIMARY KEY, holder TEXT NOT NULL, purpose TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO _everyapp_deploy_lease VALUES ('gateway', 'laptop:42:abcd', 'gateway.upgrade', ${Date.now()}, ${Date.now() + 180_000});
    `);

    const held = await deployGateway().catch((error: Error) => error);
    expect(held).toMatchObject({ code: "LEASE_HELD", retryable: true });
    expect((held as Error).message).toContain("It's from laptop. If it stopped");
    expect(held).toMatchObject({ rerunNote: expect.stringContaining("pnpm everyapp status shows it") });
    expect((held as Error).message).not.toContain("--");
    expect(account.deploys).toEqual([]);

    // That deploy died: its lease runs out.
    gatewayDb().sqlite.exec(`UPDATE _everyapp_deploy_lease SET expires_at = ${Date.now() - 1}`);
    await expect(deployGateway()).resolves.toMatchObject({ firstDeploy: true });
  });

  describe("once its lease is lost", () => {
    const migrated = () =>
      account.cf.calls.some((call) => call.args.slice(0, 3).join(" ") === "d1 migrations apply");

    it("stops before migrating", async () => {
      loseLeaseAtCheck(account, "gateway", 1);

      await expect(deployGateway()).rejects.toMatchObject({ code: "LEASE_LOST", retryable: true });
      expect(migrated()).toBe(false);
      expect(account.deploys).toEqual([]);
      // The deploy that has it now keeps it.
      expect(gatewayDb().all("SELECT holder FROM _everyapp_deploy_lease")).toEqual([
        { holder: OTHER_HOLDER },
      ]);
    });

    it("stops before uploading", async () => {
      loseLeaseAtCheck(account, "gateway", 2);

      await expect(deployGateway()).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(migrated()).toBe(true);
      expect(account.deploys).toEqual([]);
    });

    it("stops a reconcile before uploading, under the lease it took", async () => {
      await deployGateway();
      const deploys = account.deploys.length;
      loseLeaseAtCheck(account, "gateway", 1);

      await expect(reconcile({ force: true })).rejects.toMatchObject({ code: "LEASE_LOST" });
      expect(account.deploys).toHaveLength(deploys);
    });
  });

  it("asks for the workers.dev subdomain an account without one needs", async () => {
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;

    const failure = await deployGateway().catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "ActionRequiredError",
      action: "register_workers_subdomain",
      url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`,
    });
    // Migrated before the upload stopped, but a new install's database was
    // empty: there is nothing to restore.
    expect(rollbackFor(failure)).toBeUndefined();
  });

  it("asks for a terminal when the Worker was last changed in the dashboard", async () => {
    await deployGateway();
    // cf says so on stdout, with no error box.
    account.strictAbortNextDeploy = true;

    // The rerun is for a person at a terminal: built without the run's --json.
    const argv = process.argv;
    process.argv = [...argv.slice(0, 2), "update", "--json"];
    try {
      await expect(deployGateway()).rejects.toMatchObject({
        action: "rerun_interactive",
        message: expect.stringContaining("was changed outside everyapp; confirm in a terminal"),
        rerun: "pnpm everyapp update",
        rerunNote: "in a terminal, and confirm cf's prompt",
        data: { needsTerminal: true },
      });
    } finally {
      process.argv = argv;
    }

    // At a terminal, cf runs again attached and asks its own question.
    account.strictAbortNextDeploy = true;
    await deployGateway({ interactive: true });
    expect(account.deploys.at(-1)!.mode).toBe("interactive");
  });

  it("fails, and records nothing, when cf uploads nothing", async () => {
    await deployGateway();
    const before = await readInstall(cfD1Database(account.cf, [...account.databases][0]![0]));
    // A person answered no to one of cf's questions: cf exits 0.
    account.declineNextDeploy = true;

    await expect(deployGateway({ interactive: true })).rejects.toMatchObject({
      code: "DEPLOY_NOT_UPLOADED",
    });
    await expect(
      readInstall(cfD1Database(account.cf, [...account.databases][0]![0])),
    ).resolves.toEqual(before);
  });

  it("refuses an older build of the same version, unless asked", async () => {
    const newer = await laterBuild();
    try {
      await deployGateway({ release: newer });
      // An older checkout's release: same version, from before.
      const refused = await deployGateway({ reason: "upgrade" }).catch(
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({
        code: "DOWNGRADE_REFUSED",
        // A release opened from a file, not a checkout's build.
        message: expect.stringMatching(
          /^The Gateway from \/.+\.tar\.gz \(0\.2\.0 from Oct 12\) is older than the live one \(from Oct 13\)$/,
        ),
        fix: "update everyapp: npm install -g everyapp@latest",
        rerun: expect.stringMatching(/^pnpm everyapp/),
        authorize: false,
      });
      // Only setup offers the rollback.
      expect((refused as Error).message).not.toContain("--allow-downgrade");
      expect((refused as { rerun: string }).rerun).not.toContain("--allow-downgrade");
      expect(account.deploys).toHaveLength(1);

      const offered = await deployGateway({
        reason: "upgrade",
        allowDowngradeFlag: true,
      }).catch((error: unknown) => error);
      expect(offered).toMatchObject({
        code: "DOWNGRADE_REFUSED",
        rerun: expect.stringContaining("--allow-downgrade"),
        authorize: true,
      });

      await deployGateway({ reason: "upgrade", allowDowngrade: true });
      expect((await readInstall(gatewayD1()))!.releaseSha256).toBe(release.manifest.sha256);
    } finally {
      await newer.cleanup();
    }
  });

  it("never replaces a release an upgrade left unrecorded unattended, and tells a person it may be newer", async () => {
    // A, A' (built later, as an older CLI bundles it) and B (later still).
    const middle = await laterBuild();
    const newest = await openRelease(
      await buildGatewayRelease({ version: "0.2.0", builtAt: "2026-10-14T00:00:00.000Z" }),
    );
    try {
      await deployGateway();
      const rowA = await readInstall(gatewayD1());
      // B goes live, but its record is lost: the row still names A.
      await deployGateway({ reason: "upgrade", release: newest });
      await writeInstall(gatewayD1(), rowA!);
      const deploys = account.deploys.length;

      await expect(
        deployGateway({ reason: "upgrade", release: middle }),
      ).rejects.toMatchObject({ action: "rerun_interactive" });
      expect(account.deploys).toHaveLength(deploys);

      const asked: string[] = [];
      await expect(
        deployGateway({
          reason: "upgrade",
          release: middle,
          interactive: true,
          confirm: async (question, context = []) => (asked.push(question, ...context), false),
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(asked.join("\n")).toContain("If it runs a newer release (an upgrade that stopped before recording itself), this puts an older one back.");
      expect(account.deploys).toHaveLength(deploys);
    } finally {
      await middle.cleanup();
      await newest.cleanup();
    }
  });

  it("records an upload cf finished when Ctrl+C stopped the upgrade then", async () => {
    await deployGateway();
    const newer = await laterBuild();
    try {
      let interrupted: Promise<void> | undefined;
      account.afterUpload = () => {
        account.afterUpload = null;
        interrupted = handleInterrupt("SIGINT", { exit: vi.fn() });
        return { exitCode: 130, stderr: "" };
      };
      await expect(deployGateway({ reason: "upgrade", release: newer })).rejects.toThrow();
      await interrupted;

      const row = (await readInstall(gatewayD1()))!;
      expect(row.releaseSha256).toBe(newer.manifest.sha256);
      expect(row.liveVersionId).toBe(
        account.workers.get("every-app-gateway")!.versions.at(-1),
      );
      // So the next unattended deploy goes ahead (with a release opened
      // anew: the interrupt removed the copies this run had open).
      resetInterruptsForTests();
      const again = await laterBuild();
      try {
        await expect(deployGateway({ reason: "upgrade", release: again })).resolves.toMatchObject({
          versionId: expect.any(String),
        });
      } finally {
        await again.cleanup();
      }
    } finally {
      await newer.cleanup();
    }
  });

  it("checks the release again once it holds the lease", async () => {
    await deployGateway();
    const newer = await laterBuild();
    try {
      // This upgrade waits for the lease while a newer one finishes.
      const other = await holdLease(gatewayD1(), "gateway", LeasePurpose.GatewayUpgrade);
      let raced = false;
      const waiting = deployGateway({
        reason: "upgrade",
        leaseWaitMs: 60_000,
        sleep: async () => {
          if (raced) return;
          raced = true;
          await other.release();
          await deployGateway({ reason: "upgrade", release: newer });
        },
      });

      await expect(waiting).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });
      expect(account.gatewayRelease()?.sha256).toBe(newer.manifest.sha256);
    } finally {
      await newer.cleanup();
    }
  });

  describe("before migrating", () => {
    const migrated = () =>
      account.cf.calls.some((call) => call.args.slice(0, 3).join(" ") === "d1 migrations apply");

    it("stops unattended over a gateway everyapp didn't deploy", async () => {
      // A gateway the wrangler-era CLI deployed: a Worker, no install row.
      account.createDatabase("every-app-gateway");
      account.workers.set("every-app-gateway", {
        versions: ["wrangler-1"],
        config: { name: "every-app-gateway", env: {} },
        secrets: { BETTER_AUTH_SECRET: "s", JWT_PRIVATE_KEY: "k", JWT_PUBLIC_KEY: "p", GATEWAY_URL: "u" },
      });

      await expect(deployGateway()).rejects.toMatchObject({
        action: "rerun_interactive",
        message: expect.stringMatching(/^The Gateway was changed outside everyapp; confirm in a terminal\n.*Nothing changed\.$/),
        data: { workerName: "every-app-gateway", versionId: "wrangler-1", needsTerminal: true },
      });
      expect(migrated()).toBe(false);
      expect(gatewayDb().all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);

      // At a terminal, a person is asked first; no means nothing changes.
      await expect(
        deployGateway({ interactive: true, confirm: async () => false }),
      ).rejects.toMatchObject({ code: "CANCELLED" });
      expect(migrated()).toBe(false);

      const asked: string[] = [];
      await deployGateway({
        interactive: true,
        confirm: async (question, context = []) => (asked.push(question, ...context), true),
      });
      expect(asked).toEqual([
        "Replace it with 0.2.0?",
        "The Gateway's live version wasn't deployed by everyapp (dashboard, API, or an interrupted deploy).",
        expect.stringMatching(/^If it runs a newer release .* Cloudflare may ask to confirm again\.$/),
      ]);
      expect(migrated()).toBe(true);
    });

    it("stops unattended when the gateway was changed outside everyapp since", async () => {
      await deployGateway();
      // A version from the dashboard.
      account.workers.get("every-app-gateway")!.versions.push("dashboard-2");
      const calls = account.cf.calls.length;

      await expect(deployGateway({ reason: "upgrade" })).rejects.toMatchObject({
        action: "rerun_interactive",
      });
      expect(
        account.cf.calls.slice(calls).some((call) => call.args.join(" ").startsWith("d1 migrations")),
      ).toBe(false);
    });

    it("stops when the release can't be patched into this gateway", async () => {
      const config = path.join(
        release.dir,
        ".cloudflare/output/v0/workers/default/worker.config.json",
      );
      fs.writeFileSync(
        config,
        JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), compatibilityDate: 5 }),
      );

      await expect(deployGateway()).rejects.toMatchObject({ code: "INVALID_BUILD_OUTPUT" });
      expect(migrated()).toBe(false);
      expect(account.deploys).toEqual([]);
    });
  });
});

describe("per-app Custom Domains", () => {
  const GW = "apps.example.com";
  const deployOnSubdomain = (options: Partial<Parameters<typeof applyGateway>[0]> = {}) =>
    deployGateway({ gatewayHost: GW, ...options });
  // The hostnames whose records were read (not the wildcards over them).
  const hostsChecked = () =>
    account.cf.calls
      .filter((call) => call.args.slice(0, 3).join(" ") === "dns records list")
      .map((call) => call.args[call.args.indexOf("--name-exact") + 1]!)
      .filter((name) => !name.startsWith("*."));

  it("installs on a subdomain of a zone the account has, leaving the rest of the zone alone", async () => {
    account.dnsRecords.push({ zoneId: "zone-1", name: "www.example.com", type: "CNAME", content: "site.example.net" });

    const result = await deployOnSubdomain();

    expect(result.newHosts).toEqual([GW]);
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.deploys[0]!.config["env"].APP_BASE_DOMAIN.value).toBe(GW);
    expect(account.certificatePacks).toEqual([
      expect.objectContaining({ zoneId: "zone-1", hosts: ["example.com", GW, `*.${GW}`] }),
    ]);
    // www's record, and the Custom Domain's own placeholder at the gateway's host.
    expect(account.dnsRecords).toEqual([
      expect.objectContaining({ name: "www.example.com", type: "CNAME" }),
      { zoneId: "zone-1", name: GW, type: "AAAA", content: "100::" },
    ]);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      gatewayHost: GW,
      zoneName: "example.com",
      appBaseDomain: GW,
      liveDomains: [GW],
    });
    expect(hostsChecked()).toEqual([GW]);
  });

  it("publishes every bound app's host with the gateway's, as the whole list, every time", async () => {
    await deployOnSubdomain();
    seedApps([
      { slug: "todo", worker: "every-acme-todo", status: "active", hostname: `todo.${GW}` },
      { slug: "chef", worker: "every-acme-chef", status: "binding", hostname: `chef.${GW}` },
      // Not uploaded yet: neither bound nor published.
      { slug: "notes", worker: "every-acme-notes", status: "pending", hostname: `notes.${GW}` },
    ]);

    const added = await reconcile();
    expect(added).toMatchObject({
      changed: true,
      domains: [GW, `chef.${GW}`, `todo.${GW}`],
      newHosts: [`chef.${GW}`, `todo.${GW}`],
    });
    expect(account.gatewayDomains()).toEqual([GW, `chef.${GW}`, `todo.${GW}`].sort());
    expect(account.deploys.at(-1)!.config["domains"]).toEqual([
      GW,
      `chef.${GW}`,
      `todo.${GW}`,
    ]);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      liveDomains: [GW, `chef.${GW}`, `todo.${GW}`],
    });
    // Both new hosts were checked before the upload; the live one wasn't.
    expect(hostsChecked()).toEqual([GW, `chef.${GW}`, `todo.${GW}`]);

    // In sync: nothing to deploy.
    await expect(reconcile()).resolves.toMatchObject({ changed: false });

    // A deleted app's host goes with the next deploy; its certificate stays
    // for `app delete` to remove.
    gatewayDb().sqlite.exec("UPDATE apps SET status = 'deleted' WHERE app_slug = 'chef'");
    await expect(reconcile()).resolves.toMatchObject({
      changed: true,
      domains: [GW, `todo.${GW}`],
      newHosts: [],
    });
    expect(account.gatewayDomains()).toEqual([GW, `todo.${GW}`]);
    expect(account.certificatePacks.map((pack) => pack.hosts[1])).toContain(
      `chef.${GW}`,
    );
  });

  it("publishes an app's host when its Worker is already bound but its domain isn't", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active", hostname: `todo.${GW}` }]);
    await reconcile();
    // As if the live domains had been dropped (an older CLI's deploy).
    const install = (await readInstall(gatewayD1()))!;
    await writeInstall(gatewayD1(), { ...install, liveDomains: [GW] });

    await expect(reconcile()).resolves.toMatchObject({
      changed: true,
      newHosts: [`todo.${GW}`],
    });
  });

  it("refuses a new host that holds a DNS record, before deploying, unless --force-dns", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "binding", hostname: `todo.${GW}` }]);
    account.dnsRecords.push({ zoneId: "zone-1", name: `todo.${GW}`, type: "CNAME", content: "legacy.example.net" });
    const deploys = account.deploys.length;

    await expect(reconcile()).rejects.toMatchObject({
      code: "DNS_RECORD_CONFLICT",
      message: expect.stringContaining("Its DNS record: CNAME legacy.example.net."),
    });
    expect(account.deploys).toHaveLength(deploys);
    expect(account.gatewayBindings()).toEqual([]);
    expect(gatewayDb().all("SELECT * FROM _everyapp_deploy_lease")).toEqual([]);

    await expect(reconcile({ forceDns: true })).resolves.toMatchObject({
      newHosts: [`todo.${GW}`],
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "DNS_RECORD_REPLACED" }),
    );
  });

  it("checks a new install's own host before it migrates anything", async () => {
    account.dnsRecords.push({ zoneId: "zone-1", name: GW, type: "A", content: "192.0.2.1" });

    await expect(deployOnSubdomain()).rejects.toMatchObject({ code: "DNS_RECORD_CONFLICT" });

    expect(
      account.cf.calls.some((call) => call.args.slice(0, 3).join(" ") === "d1 migrations apply"),
    ).toBe(false);
    expect(account.deploys).toEqual([]);
  });

  it("refuses a new host a wildcard record answers, like one of its own, unless --force-dns", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "binding", hostname: `todo.${GW}` }]);
    account.dnsRecords.push({ zoneId: "zone-1", name: `*.${GW}`, type: "CNAME", content: "site.example.net" });

    await expect(reconcile()).rejects.toMatchObject({
      code: "DNS_RECORD_CONFLICT",
      message: expect.stringContaining(`Its DNS record: CNAME site.example.net, through *.${GW}.`),
    });
    expect(account.gatewayDomains()).toEqual([GW]);

    await expect(reconcile({ forceDns: true })).resolves.toMatchObject({
      newHosts: [`todo.${GW}`],
    });
  });

  it("refuses the 101st Custom Domain in a zone and warns from the 95th", async () => {
    await deployOnSubdomain();
    const apps = Array.from({ length: 99 }, (_, i) => ({
      slug: `app${i}`,
      worker: `every-acme-app${i}`,
      status: "active",
      hostname: `app${i}.${GW}`,
    }));
    seedApps(apps.slice(0, 93));
    await reconcile();
    expect(account.gatewayDomains()).toHaveLength(94);
    expect(events.some((event) => event["code"] === "ZONE_CUSTOM_DOMAIN_LIMIT_NEAR")).toBe(false);

    seedApps(apps.slice(93));
    await expect(reconcile()).resolves.toMatchObject({ changed: true });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "ZONE_CUSTOM_DOMAIN_LIMIT_NEAR" }),
    );
    expect(account.gatewayDomains()).toHaveLength(100);

    seedApps([{ slug: "one-more", worker: "every-acme-one-more", status: "active", hostname: `one-more.${GW}` }]);
    await expect(reconcile()).rejects.toMatchObject({ code: "ZONE_CUSTOM_DOMAIN_LIMIT" });
    expect(account.gatewayDomains()).toHaveLength(100);
  });

  it("never publishes a registry host that isn't one label below the base domain", async () => {
    await deployOnSubdomain();
    seedApps([
      { slug: "todo", worker: "every-acme-todo", status: "active", hostname: `todo.${GW}` },
      { slug: "site", worker: "every-acme-site", status: "active", hostname: "www.example.com" },
    ]);

    await reconcile();

    expect(account.gatewayDomains()).toEqual([GW, `todo.${GW}`]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "APP_HOST_OUTSIDE_BASE",
        message: expect.stringContaining("www.example.com"),
      }),
    );
  });

  it("replaces its own upload from a run that stopped after publishing the hostname, without asking", async () => {
    // The account's first Worker: cf put the version and its Custom Domain
    // live, then stopped for the workers.dev subdomain. The install row is
    // as the live run of 2026-10-24 left it: written before the upload,
    // never updated with the version.
    account.workersDevSubdomain = false;
    await expect(deployOnSubdomain()).rejects.toMatchObject({ action: "register_workers_subdomain" });
    expect(account.gatewayDomains()).toEqual([GW]);
    expect(account.dnsRecords).toEqual([{ zoneId: "zone-1", name: GW, type: "AAAA", content: "100::" }]);
    gatewayDb().sqlite.exec(
      "UPDATE _everyapp_install SET live_version_id = NULL, jwt_public_key = NULL, deployment_mode = NULL",
    );
    const firstVersion = account.workers.get("every-app-gateway")!.versions.at(-1);
    account.workersDevSubdomain = true;
    events = [];

    // Unattended, the same deploy goes through: the hostname's record is
    // the Gateway's own, and so is the Worker.
    const result = await deployOnSubdomain();

    expect(result).toMatchObject({ firstDeploy: false, domains: [GW], newHosts: [GW] });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "gateway.domains",
        message: `${GW} is already this Gateway's Custom Domain (an earlier run published it, then stopped)`,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "step",
        step: "gateway.resume",
        status: "ok",
        message: `Replacing the Gateway an earlier run uploaded at ${GW}\nThat run stopped before it could finish; nothing uses that upload yet.`,
        data: { gatewayHost: GW },
      }),
    );
    expect(events.some((event) => event["code"] === "DNS_RECORD_CONFLICT" || event["action"] === "rerun_interactive")).toBe(false);
    // The row's first upload: a new key pair, recorded with the version.
    const upload = account.deploys.at(-1)!;
    expect(upload.secrets).toHaveProperty("JWT_PUBLIC_KEY");
    const row = (await readInstall(gatewayD1()))!;
    expect(row.liveVersionId).toBe(account.workers.get("every-app-gateway")!.versions.at(-1));
    expect(row.liveVersionId).not.toBe(firstVersion);
    expect(row).toMatchObject({
      liveDomains: [GW],
      jwtPublicKey: upload.secrets!["JWT_PUBLIC_KEY"],
      deploymentMode: "self_hosted",
    });
  });

  it("still asks before replacing a Gateway Worker that doesn't hold the row's hostname", async () => {
    // A row that never recorded an upload, and a Worker by the Gateway's
    // name whose Custom Domain is some other hostname: not this install's.
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;
    await expect(deployOnSubdomain()).rejects.toMatchObject({ action: "register_workers_subdomain" });
    account.workers.set("every-app-gateway", {
      versions: ["elsewhere-1"],
      config: { name: "every-app-gateway", env: {} },
      secrets: {},
    });
    account.customDomains.set("tools.example.com", "every-app-gateway");
    const deploys = account.deploys.length;

    await expect(deployOnSubdomain()).rejects.toMatchObject({
      action: "rerun_interactive",
      data: { workerName: "every-app-gateway", versionId: "elsewhere-1" },
    });
    expect(account.deploys).toHaveLength(deploys);
    expect(events.some((event) => event["step"] === "gateway.resume")).toBe(false);
  });

  it("warns, unattended, that cf moves a host another Worker serves without asking", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active", hostname: `todo.${GW}` }]);
    account.customDomains.set(`todo.${GW}`, "some-other-worker");

    await reconcile();

    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CUSTOM_DOMAIN_OWNER_UNCHECKED" }),
    );
    expect(account.customDomains.get(`todo.${GW}`)).toBe("every-app-gateway");
  });

  it("records only the version when cf stops before publishing its hostnames, so the next run checks them again", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active", hostname: `todo.${GW}` }]);
    account.customDomains.set(`todo.${GW}`, "marketing-site");
    const before = (await readInstall(gatewayD1()))!;

    // At a terminal: cf puts the new version live, then asks whether to
    // move todo.<GW> from marketing-site. No: it skips the domains, exit 1.
    account.afterUpload = (worker) =>
      worker === "every-app-gateway"
        ? customDomainsSkipped(worker, [GW, `todo.${GW}`])
        : undefined;
    await expect(reconcile({ interactive: true })).rejects.toThrow(
      "only partially updated",
    );
    account.afterUpload = null;

    // The version that went live is recorded, with the app it binds; the
    // hostnames stay as the last finished deploy left them.
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(account.customDomains.get(`todo.${GW}`)).toBe("marketing-site");
    await expect(readInstall(gatewayD1())).resolves.toEqual({
      ...before,
      liveVersionId: account.workers.get("every-app-gateway")!.versions.at(-1),
      liveAppWorkers: ["every-acme-todo"],
      updatedAt: expect.any(Number),
      updatedBy: expect.any(String),
    });

    // So the next run, unattended, checks the hostname as a new one again
    // and says it can't tell which Worker holds it, before moving it.
    events = [];
    const checked = hostsChecked().length;
    await reconcile({ stagedSecrets: { OPENAI_API_KEY: "sk-test" } });
    expect(hostsChecked().slice(checked)).toEqual([`todo.${GW}`]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "CUSTOM_DOMAIN_OWNER_UNCHECKED",
        data: { hosts: [`todo.${GW}`] },
      }),
    );
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      liveDomains: [GW, `todo.${GW}`],
    });
  });
});

describe("reconcileGateway", () => {
  beforeEach(async () => {
    await deployGateway();
  });

  it("binds the apps that are uploaded, and nothing else", async () => {
    seedApps([
      { slug: "todo", worker: "every-acme-todo", status: "active" },
      { slug: "chef", worker: "every-acme-chef", status: "binding" },
      { slug: "gym", worker: "every-acme-gym", status: "disabled" },
      { slug: "notes", worker: "every-acme-notes", status: "pending" },
      { slug: "gone", worker: "every-acme-gone", status: "deleted" },
      // A row pointing at someone else's Worker is never bound.
      { slug: "billing", worker: "billing-api", status: "active" },
    ]);

    const result = await reconcile();

    expect(result.changed).toBe(true);
    expect(account.gatewayBindings()).toEqual([
      "every-acme-chef",
      "every-acme-gym",
      "every-acme-todo",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "APP_NOT_BOUND" }),
    );
    // The same release, untouched by the reconcile.
    expect(account.deploys.at(-1)!.config["env"].EVERYAPP_RELEASE.value.sha256).toBe(
      release.manifest.sha256,
    );
    expect(account.deploys.at(-1)!.secrets).toBeNull();
  });

  it("skips an app whose Worker is gone, and binds the rest", async () => {
    seedApps([
      { slug: "todo", worker: "every-acme-todo", status: "active" },
      // Marked deployed, but its Worker was deleted by hand.
      { slug: "chef", worker: "every-acme-chef", status: "active", missing: true },
    ]);

    await expect(reconcile()).resolves.toMatchObject({ changed: true });

    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "APP_WORKER_MISSING",
        message: expect.stringMatching(/^Skipping chef: its Worker is missing\n/),
      }),
    );
    // Bound as the registry says, less the missing one: nothing to redo.
    await expect(reconcile()).resolves.toMatchObject({ changed: false });
  });

  it("does nothing when the live gateway already binds the registry's apps", async () => {
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    await reconcile();
    const deploys = account.deploys.length;

    await expect(reconcile()).resolves.toMatchObject({ changed: false });
    expect(account.deploys).toHaveLength(deploys);
  });

  const migrations = () =>
    account.cf.calls.filter(
      (call) => call.args.slice(0, 3).join(" ") === "d1 migrations list",
    ).length;

  it("redeploys the release that is live without migrating anything", async () => {
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    const before = migrations();

    await reconcile();

    expect(migrations()).toBe(before);
    expect(account.deploys.at(-1)!.config["env"].EVERYAPP_RELEASE.value).toEqual({
      version: "0.2.0",
      sha256: release.manifest.sha256,
    });
  });

  it("takes another build of the live sources as the live release, since builds differ byte for byte", async () => {
    // Installed from sources whose tree hash is "tree-1".
    gatewayDb().sqlite.exec("UPDATE _everyapp_install SET source_tree_sha256 = 'tree-1'");
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    // Another machine's build of the same tree: another SHA-256.
    const rebuilt = await buildGatewayRelease({ builtAt: "2026-10-12T06:00:00.000Z" });
    const before = migrations();

    await reconcile({
      force: true,
      openRelease: () => openRelease(rebuilt, { origin: { kind: "checkout" }, treeSha256: "tree-1", committedAt: null }),
    });

    // A rebind, not an upgrade: nothing migrated, nothing asked.
    expect(migrations()).toBe(before);
    expect(account.gatewayBindings()).toEqual(["every-acme-todo"]);
  });

  it("deploys the release this checkout builds, upgrading the gateway when it is newer", async () => {
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    const newer = await buildGatewayRelease({
      version: "0.2.0",
      builtAt: "2026-10-13T00:00:00.000Z",
    });
    const before = migrations();

    await reconcile({ force: true, openRelease: () => openRelease(newer) });

    // Bookmarked and migrated first, as any upgrade.
    expect(migrations()).toBe(before + 1);
    const live = account.deploys.at(-1)!.config["env"].EVERYAPP_RELEASE.value;
    expect(live.sha256).not.toBe(release.manifest.sha256);
    expect((await readInstall(gatewayD1()))!).toMatchObject({
      releaseSha256: live.sha256,
      liveAppWorkers: ["every-acme-todo"],
    });
  });

  it("refuses, under the lease, to put back a release older than one an upgrade made live meanwhile", async () => {
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    const newer = await laterBuild();
    try {
      // An upgrade holds the lease; the install row still names release A.
      const upgrade = await holdLease(gatewayD1(), "gateway", LeasePurpose.GatewayUpgrade);
      let upgraded = false;

      await expect(
        reconcile({
          force: true,
          leaseWaitMs: 60_000,
          // While the reconcile waits for the lease, the upgrade finishes.
          sleep: async () => {
            if (upgraded) return;
            upgraded = true;
            await upgrade.release();
            await deployGateway({ reason: "upgrade", release: newer });
          },
        }),
      ).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });

      expect(upgraded).toBe(true);
      expect(account.gatewayRelease()?.sha256).toBe(newer.manifest.sha256);
      expect((await readInstall(gatewayD1()))!.releaseSha256).toBe(newer.manifest.sha256);
    } finally {
      await newer.cleanup();
    }
  });

  it("takes the install row's word for what is live: cf alone stops it over a dashboard edit", async () => {
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "active" }]);
    // A version the row doesn't name.
    account.workers.get("every-app-gateway")!.versions.push("dashboard-2");
    account.strictAbortNextDeploy = true;

    await expect(reconcile()).rejects.toMatchObject({ action: "rerun_interactive" });

    // At a terminal, cf runs again attached and asks its own question; the
    // row's release goes live.
    account.strictAbortNextDeploy = true;
    await reconcile({ interactive: true });
    expect(account.deploys.at(-1)!.mode).toBe("interactive");
    expect((await readInstall(gatewayD1()))!.liveVersionId).toBe(
      account.workers.get("every-app-gateway")!.versions.at(-1),
    );
  });

  it("leaves no release it opened behind when it fails", async () => {
    const older = await buildGatewayRelease({
      version: "0.2.0",
      builtAt: "2026-10-11T00:00:00.000Z",
    });
    const opened = () =>
      fs
        .readdirSync(path.join(home, ".everyapp", "cf", "tmp"))
        .filter((entry) => entry.startsWith("gateway-release-"));
    const before = opened();

    await expect(
      reconcile({ force: true, openRelease: () => openRelease(older) }),
    ).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });

    expect(opened()).toEqual(before);
  });

  it("sends a setting with the redeploy, in the secrets file", async () => {
    await reconcile({ stagedSecrets: { OPENAI_API_KEY: "sk-test" } });

    expect(account.deploys.at(-1)!.secrets).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(account.deploys.at(-1)!.args.join(" ")).not.toContain("sk-test");
  });
});
