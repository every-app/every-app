/**
 * `everyapp gateway deploy|upgrade|reconcile` end to end, against a fake
 * Cloudflare account: real gateway migrations on SQLite, Build Outputs
 * validated with cf's schema, nothing spawned or sent.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { createNdjsonSink } from "@/lib/output/events";
import {
  ACCOUNT_ID,
  customDomainsSkipped,
  FakeCloudflare,
} from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { handleInterrupt, resetInterruptsForTests } from "@/lib/interrupt";
import { applyGateway } from "./apply";
import { readInstall, writeInstall } from "./install";
import { acquireLease } from "./lease";
import { reconcileGateway } from "./reconcile";
import { openRelease, type GatewayRelease } from "./release";
import { ensureGatewayResources } from "./resources";

let account: FakeCloudflare;
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
  release = await openRelease(await buildGatewayRelease());
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
    routing: "custom-domains",
    appBaseDomain: options.gatewayHost ?? "example.com",
    resources,
    db: cfD1Database(account.cf, [...account.databases][0]![0]),
    interactive: false,
    cliVersion: "0.3.0",
    readStatus: () => account.gatewayStatus(),
    sleep: noSleep,
    verifyTimeoutMs: 0,
    leaseWaitMs: 0,
    lookupCaa: account.lookupCaa,
    ...options,
  });
}

function reconcile(options: Partial<Parameters<typeof reconcileGateway>[0]> = {}) {
  return reconcileGateway({
    cf: account.cf,
    out: out(),
    accountId: ACCOUNT_ID,
    interactive: false,
    cliVersion: "0.3.0",
    readStatus: () => account.gatewayStatus(),
    sleep: noSleep,
    verifyTimeoutMs: 0,
    leaseWaitMs: 0,
    lookupCaa: account.lookupCaa,
    ...options,
  });
}

const gatewayDb = () => account.database("every-app-gateway");
const gatewayD1 = () =>
  cfD1Database(account.cf, [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0]);

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
    legacy?: boolean;
    /** Its Worker was never uploaded, or was deleted by hand. */
    missing?: boolean;
    /** Default: `<slug>-acme.example.com`, as gateways name apps without APP_BASE_DOMAIN. */
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
      "INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, manifest, status, legacy_names) VALUES (?, 'org-1', ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      `row-${row.slug}`,
      row.slug,
      row.slug,
      row.slug,
      row.hostname ?? `${row.slug}-acme.example.com`,
      row.worker,
      JSON.stringify({ id: row.slug }),
      row.status,
      row.legacy ? 1 : 0,
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

describe("gateway deploy", () => {
  it("installs a gateway: migrations first, then one upload with its secrets", async () => {
    const result = await deployGateway();

    // The order that keeps a failure safe: lease, bookmark, history,
    // migrations and the release cache all before the upload.
    const commands = account.cf.calls.map((call) => call.args.slice(0, 3).join(" "));
    const order = [
      "d1 query", // the lease (and its table)
      "d1 time-travel get-bookmark",
      "d1 migrations apply",
      "kv keys put",
      "deploy --prebuilt --mode",
    ].map((command) => commands.findIndex((c) => c.startsWith(command)));
    expect(order.every((index, i) => i === 0 || index > order[i - 1]!)).toBe(true);

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
    await expect(readInstall(cfD1Database(account.cf, [...account.databases][0]![0]))).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      gatewayHost: "example.com",
      zoneId: "zone-1",
      routing: "custom-domains",
      appBaseDomain: "example.com",
      liveDomains: ["example.com"],
      releaseSha256: release.manifest.sha256,
      liveVersionId: account.workers.get("every-app-gateway")!.versions[0],
    });
    const cached = JSON.parse(
      fs.readFileSync(path.join(home, ".everyapp", "installs.json"), "utf8"),
    );
    expect(cached.installs["example.com"]).toMatchObject({ accountId: ACCOUNT_ID });
    expect(fs.statSync(path.join(home, ".everyapp", "installs.json")).mode & 0o777).toBe(0o600);
  });

  it("redeploys without secrets, and confirms the live gateway serves it", async () => {
    await deployGateway();
    const result = await deployGateway();

    expect(account.deploys).toHaveLength(2);
    expect(account.deploys[1]!.secrets).toBeNull();
    expect(result).toMatchObject({ firstDeploy: false, verified: true });
  });

  it("carries drizzle-kit's history over on a gateway it migrated before", async () => {
    const { uuid, db } = account.createDatabase("every-app-gateway");
    const { migrateGatewayWithDrizzle } = await import("@/test/sqliteD1");
    migrateGatewayWithDrizzle(db, release.manifest.migrations.length - 1);
    expect(uuid).toBeTruthy();

    await deployGateway();

    // The newest migration ran; the others were only recorded.
    expect(db.all("SELECT name FROM d1_migrations ORDER BY id").at(-1)).toEqual({
      name: `${release.manifest.migrations.at(-1)!.tag}.sql`,
    });
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
      message: expect.stringContaining("d1 time-travel restore"),
    });
    expect(account.deploys).toHaveLength(1);
    expect(account.workers.get("every-app-gateway")!.versions).toEqual(serving);
    expect(gatewayDb().all("SELECT * FROM _everyapp_deploy_lease")).toEqual([]);
  });

  it("waits for, and then gives up on, a deploy that holds the lease", async () => {
    await ensureGatewayResources(account.cf);
    gatewayDb().sqlite.exec(`
      CREATE TABLE _everyapp_deploy_lease (id TEXT PRIMARY KEY, holder TEXT NOT NULL, purpose TEXT NOT NULL, acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      INSERT INTO _everyapp_deploy_lease VALUES ('gateway', 'laptop:42:abcd', 'gateway.upgrade', ${Date.now()}, ${Date.now() + 600_000});
    `);

    await expect(deployGateway()).rejects.toMatchObject({
      code: "LEASE_HELD",
      message: expect.stringContaining("laptop:42:abcd"),
    });
    expect(account.deploys).toEqual([]);

    await expect(deployGateway({ breakLease: async () => true })).resolves.toMatchObject({
      firstDeploy: true,
    });
  });

  it("asks for the workers.dev subdomain an account without one needs", async () => {
    account.failNextDeploy = `You need a workers.dev subdomain before your first upload. Register one: https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`;

    await expect(deployGateway()).rejects.toMatchObject({
      name: "ActionRequiredError",
      action: "register_workers_subdomain",
      url: `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/onboarding`,
    });
  });

  it("asks for a terminal when the Worker was last changed in the dashboard", async () => {
    await deployGateway();
    account.failNextDeploy =
      "Aborting the upload operation because of conflicts. To override and upload anyway, remove the `--strict` flag";

    await expect(deployGateway()).rejects.toMatchObject({
      action: "rerun_interactive",
      message: expect.stringContaining("Run this command again in a terminal"),
    });

    // At a terminal, cf runs attached and asks its own question.
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
      // An older CLI's bundled release: same version, built before.
      await expect(deployGateway({ reason: "upgrade" })).rejects.toMatchObject({
        code: "DOWNGRADE_REFUSED",
      });
      expect(account.deploys).toHaveLength(1);

      await deployGateway({ reason: "upgrade", allowDowngrade: true });
      expect((await readInstall(gatewayD1()))!.releaseSha256).toBe(release.manifest.sha256);
    } finally {
      await newer.cleanup();
    }
  });

  it("never replaces a newer release an upgrade left unrecorded with an older one", async () => {
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

      // Even a person saying yes to replacing an unrecorded version.
      await expect(
        deployGateway({
          reason: "upgrade",
          release: middle,
          interactive: true,
          confirm: async () => true,
        }),
      ).rejects.toMatchObject({ code: "DOWNGRADE_REFUSED" });
      expect(account.deploys).toHaveLength(deploys);
    } finally {
      await middle.cleanup();
      await newest.cleanup();
    }
  });

  it("records what went live before verifying it", async () => {
    await deployGateway();
    const newer = await laterBuild();
    try {
      // Stopped while waiting for the edge to serve it (Ctrl+C, a crash).
      await expect(
        deployGateway({
          reason: "upgrade",
          release: newer,
          readStatus: async () => Promise.reject(new Error("fetch failed")),
          verifyTimeoutMs: 60_000,
          sleep: async () => {
            throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");

      const row = (await readInstall(gatewayD1()))!;
      expect(row.releaseSha256).toBe(newer.manifest.sha256);
      expect(row.liveVersionId).toBe(
        account.workers.get("every-app-gateway")!.versions.at(-1),
      );
    } finally {
      await newer.cleanup();
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
      const other = await acquireLease({
        db: gatewayD1(),
        id: "gateway",
        purpose: "gateway.upgrade",
        heartbeatMs: 0,
      });
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
      expect((await account.gatewayStatus()).release?.sha256).toBe(newer.manifest.sha256);
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
        message: expect.stringContaining("nothing was migrated or uploaded"),
      });
      expect(migrated()).toBe(false);
      expect(gatewayDb().all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);

      // At a terminal, a person is asked first; no means nothing changes.
      await expect(
        deployGateway({ interactive: true, confirm: async () => false }),
      ).rejects.toMatchObject({ code: "DEPLOY_CANCELLED" });
      expect(migrated()).toBe(false);

      const asked: string[] = [];
      await deployGateway({
        interactive: true,
        confirm: async (question) => (asked.push(question), true),
      });
      expect(asked[0]).toMatch(/every-app-gateway is serving a version everyapp didn't record/);
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
        account.cf.calls.slice(calls).some((call) => call.args.join(" ").startsWith("d1 time-travel")),
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

  it("checks a dry run without taking the lease or deploying", async () => {
    await deployGateway();
    const result = await deployGateway({ dryRun: true, reason: "reconcile" });

    expect(result.dryRunOutput).toContain("Dry run: every-app-gateway");
    expect(account.deploys).toHaveLength(1);
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
      expect.objectContaining({ zoneId: "zone-1", hosts: [GW] }),
    ]);
    expect(account.dnsRecords).toHaveLength(1);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      gatewayHost: GW,
      zoneName: "example.com",
      appBaseDomain: GW,
      routing: "custom-domains",
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
    expect(account.certificatePacks.map((pack) => pack.hosts[0])).toContain(
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
      message: expect.stringContaining(`todo.${GW} (CNAME legacy.example.net)`),
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

  it("refuses a host whose zone's CAA records allow none of Cloudflare's certificate authorities", async () => {
    await deployOnSubdomain();
    seedApps([{ slug: "todo", worker: "every-acme-todo", status: "binding", hostname: `todo.${GW}` }]);
    account.caaRecords.set("example.com", ['0 issue "digicert.com"', '0 iodef "mailto:sec@example.com"']);

    await expect(reconcile()).rejects.toMatchObject({
      code: "CAA_BLOCKS_ISSUANCE",
      message: expect.stringContaining("CAA at example.com allows digicert.com"),
    });
    // Sectigo only issues Cloudflare's backup certificates.
    account.caaRecords.set("example.com", ['0 issue "sectigo.com"']);
    await expect(reconcile()).rejects.toMatchObject({ code: "CAA_BLOCKS_ISSUANCE" });
    expect(account.gatewayDomains()).toEqual([GW]);

    // Allowed only for one validation method: published, with a warning.
    account.caaRecords.set("example.com", ['0 issue "digicert.com"', '0 issue "letsencrypt.org; validationmethods=dns-01"']);
    await expect(reconcile()).resolves.toMatchObject({ newHosts: [`todo.${GW}`] });
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "CAA_MAY_BLOCK_ISSUANCE", data: { hosts: [`todo.${GW}`] } }),
    );
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
    // routing and hostnames stay as the last finished deploy left them.
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

  it("keeps an install served through its wildcard route on it, untouched", async () => {
    await deployGateway({ routing: "wildcard-route" });
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);
    const checked = hostsChecked().length;

    await reconcile();

    const deploy = account.deploys.at(-1)!;
    expect(deploy.config["domains"]).toEqual(["example.com"]);
    expect(deploy.config["triggers"]).toEqual([
      { type: "scheduled", schedule: "17 * * * *" },
      { type: "fetch", pattern: "*.example.com/*", zone: "zone-1" },
    ]);
    expect(deploy.config["env"].APP_BASE_DOMAIN).toBeUndefined();
    expect(account.gatewayBindings()).toEqual(["every-todo"]);
    // Its app hosts ride the wildcard: none is checked or published.
    expect(hostsChecked()).toHaveLength(checked);
    expect(account.gatewayDomains()).toEqual(["example.com"]);
    await expect(readInstall(gatewayD1())).resolves.toMatchObject({
      routing: "wildcard-route",
      liveDomains: ["example.com"],
    });
  });
});

describe("gateway reconcile", () => {
  beforeEach(async () => {
    await deployGateway();
  });

  it("binds legacy and org-scoped apps that are uploaded, and nothing else", async () => {
    seedApps([
      { slug: "todo", worker: "every-todo", status: "active", legacy: true },
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
      "every-todo",
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
      { slug: "todo", worker: "every-todo", status: "active", legacy: true },
      // Marked deployed, but its Worker was deleted by hand.
      { slug: "chef", worker: "every-acme-chef", status: "active", missing: true },
    ]);

    await expect(reconcile()).resolves.toMatchObject({ changed: true });

    expect(account.gatewayBindings()).toEqual(["every-todo"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "APP_WORKER_MISSING",
        message: expect.stringContaining("every-acme-chef"),
      }),
    );
    // Bound as the registry says, less the missing one: nothing to redo.
    await expect(reconcile()).resolves.toMatchObject({ changed: false });
  });

  it("does nothing when the live gateway already binds the registry's apps", async () => {
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);
    await reconcile();
    const deploys = account.deploys.length;

    await expect(reconcile()).resolves.toMatchObject({ changed: false });
    expect(account.deploys).toHaveLength(deploys);
  });

  it("picks its release under the lease: after an upgrade, never the old one the edge still reports", async () => {
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);
    const newer = await laterBuild();
    try {
      // An upgrade holds the lease, and the edge still reports release A.
      const upgrade = await acquireLease({
        db: gatewayD1(),
        id: "gateway",
        purpose: "gateway.upgrade",
        heartbeatMs: 0,
      });
      const stale = await account.gatewayStatus();
      let upgraded = false;

      await reconcile({
        force: true,
        leaseWaitMs: 60_000,
        readStatus: async () => stale,
        // While the reconcile waits for the lease, the upgrade finishes.
        sleep: async () => {
          if (upgraded) return;
          upgraded = true;
          await upgrade.release();
          await deployGateway({ reason: "upgrade", release: newer });
        },
      });

      expect(upgraded).toBe(true);
      const live = account.deploys.at(-1)!.config["env"].EVERYAPP_RELEASE.value;
      expect(live.sha256).toBe(newer.manifest.sha256);
      expect(account.gatewayBindings()).toEqual(["every-todo"]);
      expect((await readInstall(gatewayD1()))!.releaseSha256).toBe(newer.manifest.sha256);
    } finally {
      await newer.cleanup();
    }
  });

  describe("when the Worker serves another version than the install row names", () => {
    let newer: GatewayRelease;
    let rowA: Awaited<ReturnType<typeof readInstall>>;

    // Release A is recorded; then B goes live, but its record is lost.
    beforeEach(async () => {
      rowA = await readInstall(gatewayD1());
      newer = await laterBuild();
      await deployGateway({ reason: "upgrade", release: newer });
      await writeInstall(gatewayD1(), rowA!);
      seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);
    });
    afterEach(() => newer.cleanup());

    const liveRelease = () =>
      account.workers.get("every-app-gateway")!.config["env"].EVERYAPP_RELEASE.value
        .sha256 as string;

    it("reconciles the live release when it is the newer one", async () => {
      await reconcile();

      expect(liveRelease()).toBe(newer.manifest.sha256);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "warning", code: "INSTALL_RECORD_STALE" }),
      );
      expect((await readInstall(gatewayD1()))!.releaseSha256).toBe(newer.manifest.sha256);
    });

    it("never redeploys the recorded release unattended when it can't tell", async () => {
      const deploys = account.deploys.length;
      // The status endpoint doesn't answer.
      await expect(
        reconcile({ readStatus: async () => Promise.reject(new Error("fetch failed")) }),
      ).rejects.toMatchObject({ action: "rerun_interactive" });
      // The live release can't be fetched from the cache.
      const kv = account.namespaces.get(account.namespaceId("every-app-gateway-deploy")!)!;
      kv.keys.delete(`release/${newer.manifest.sha256}`);
      await expect(reconcile()).rejects.toMatchObject({ action: "rerun_interactive" });

      expect(account.deploys).toHaveLength(deploys);
      expect(liveRelease()).toBe(newer.manifest.sha256);
    });

    it("leaves no release it opened behind when it fails", async () => {
      // The cache holds the wrong release under B's key.
      const kv = account.namespaces.get(account.namespaceId("every-app-gateway-deploy")!)!;
      kv.keys.set(
        `release/${newer.manifest.sha256}`,
        kv.keys.get(`release/${release.manifest.sha256}`)!,
      );

      await expect(reconcile()).rejects.toMatchObject({ code: "RELEASE_CACHE_MISMATCH" });

      expect(
        fs.readdirSync(path.join(home, ".everyapp", "cf", "tmp")).filter((entry) =>
          entry.startsWith("gateway-cached-"),
        ),
      ).toEqual([]);
    });

    it("never trusts an edge that still answers from the version before", async () => {
      // The edge lags the upgrade: it still answers from A's version,
      // reporting A, which is what the install row names.
      const lagging = async () => ({
        ...(await account.gatewayStatus()),
        versionId: rowA!.liveVersionId,
        release: { version: release.manifest.version, sha256: release.manifest.sha256 },
      });
      const deploys = account.deploys.length;

      await expect(reconcile({ readStatus: lagging })).rejects.toMatchObject({
        action: "rerun_interactive",
        message: expect.stringContaining("didn't say, from that version"),
      });

      expect(account.deploys).toHaveLength(deploys);
      expect(liveRelease()).toBe(newer.manifest.sha256);
    });

    it("leaves a release rolled back by hand alone unless a person says so", async () => {
      // A rollback to A by hand: the Worker serves A, the row names B.
      await writeInstall(gatewayD1(), {
        ...(await readInstall(gatewayD1()))!,
        releaseVersion: newer.manifest.version,
        releaseSha256: newer.manifest.sha256,
        releaseOrder: { schema: rowA!.releaseOrder!.schema, builtAt: Date.parse(newer.manifest.builtAt) },
      });
      account.workers.get("every-app-gateway")!.config["env"].EVERYAPP_RELEASE.value = {
        version: release.manifest.version,
        sha256: release.manifest.sha256,
      };
      account.workers.get("every-app-gateway")!.versions.push("rollback-by-hand");

      await expect(reconcile()).rejects.toMatchObject({ action: "rerun_interactive" });
      await expect(
        reconcile({ interactive: true, confirm: async () => false }),
      ).rejects.toMatchObject({ code: "DEPLOY_CANCELLED" });
      await reconcile({ interactive: true, confirm: async () => true });
      expect(liveRelease()).toBe(newer.manifest.sha256);
    });
  });

  it("redeploys the live release from the cache, never the CLI's own", async () => {
    const newer = await buildGatewayRelease({ version: "9.9.9" });
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);

    await reconcile({ bundledTarball: newer });

    expect(account.deploys.at(-1)!.config["env"].EVERYAPP_RELEASE.value).toEqual({
      version: "0.2.0",
      sha256: release.manifest.sha256,
    });
  });

  it("refuses a cached release that doesn't hash to the live one", async () => {
    const kv = account.namespaces.get(account.namespaceId("every-app-gateway-deploy")!)!;
    const other = await buildGatewayRelease({ version: "6.6.6" });
    kv.keys.set(
      `release/${release.manifest.sha256}`,
      fs.readFileSync(other).toString("base64"),
    );
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);

    await expect(reconcile()).rejects.toMatchObject({
      code: "RELEASE_CACHE_MISMATCH",
    });
    expect(account.deploys).toHaveLength(1);
  });

  it("falls back to the bundled release only when it is the live one", async () => {
    const kv = account.namespaces.get(account.namespaceId("every-app-gateway-deploy")!)!;
    kv.keys.clear();
    seedApps([{ slug: "todo", worker: "every-todo", status: "active", legacy: true }]);

    await expect(
      reconcile({ bundledTarball: await buildGatewayRelease({ version: "1.0.0" }) }),
    ).rejects.toMatchObject({ code: "RELEASE_NOT_CACHED" });

    await expect(
      reconcile({ bundledTarball: release.tarball }),
    ).resolves.toMatchObject({ changed: true });
  });

  it("sends a setting with the redeploy, in the secrets file", async () => {
    await reconcile({ stagedSecrets: { OPENAI_API_KEY: "sk-test" } });

    expect(account.deploys.at(-1)!.secrets).toEqual({ OPENAI_API_KEY: "sk-test" });
    expect(account.deploys.at(-1)!.args.join(" ")).not.toContain("sk-test");
  });
});
