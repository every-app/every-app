/**
 * Taking over the gateway the wrangler-era CLI deployed (thecomeup.cc):
 * adopt it as it is, upgrade it from a terminal, keep its wildcard route
 * and app hostnames, and switch it to per-app Custom Domains when asked.
 * Against a fake Cloudflare account, as the deploy tests are.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deployGatewayRelease,
  findInstall,
  gatewayTarget,
} from "@/commands/gateway/deploy/deployGateway";
import { cfD1Database } from "@/lib/cf/d1";
import { createNdjsonSink } from "@/lib/output/events";
import {
  ACCOUNT_ID,
  customDomainsSkipped,
  FakeCloudflare,
} from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { makeTestHome } from "@/test/home";
import { migrateGatewayWithDrizzle, type SqliteD1 } from "@/test/sqliteD1";
import { adoptGateway, assertServesGateway, describeInventory, inventoryGateway } from "./adopt";
import { readInstall } from "./install";
import { reconcileGateway } from "./reconcile";
import { openRelease } from "./release";

const HOST = "thecomeup.cc";

let account: FakeCloudflare;
let gatewayDb: SqliteD1;
let databaseId: string;
let home: string;
let tarball: string;
let events: any[];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = {
  readStatus: () => account.gatewayStatus(),
  sleep: async () => undefined,
  verifyTimeoutMs: 0,
  leaseWaitMs: 0,
};

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  events = [];
  tarball = await buildGatewayRelease();
  account = new FakeCloudflare();
  account.zones.push({ id: "zone-tcc", name: HOST, status: "active" });

  // What the wrangler-era CLI left: a database drizzle-kit migrated, the
  // gateway Worker (secrets set through the API) on the apex with a
  // wildcard route over a proxied `*` record, its OAuth namespace, and two
  // apps at <app>-<org>.thecomeup.cc.
  const created = account.createDatabase("every-app-gateway");
  databaseId = created.uuid;
  gatewayDb = created.db;
  migrateGatewayWithDrizzle(gatewayDb);
  // The "default" organization the founder owns.
  const org = "00000000-0000-4000-8000-000000000001";
  gatewayDb.sqlite.exec(`
    INSERT INTO organizations (id, name, slug, created_at) VALUES ('${org}', 'Default Organization', 'default', 0);
    INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES ('founder', 'Founder', 'f@thecomeup.cc', 1, 0, 0);
    INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES ('m1', '${org}', 'founder', 'owner', 0);
    INSERT INTO apps (id, organization_id, app_slug, name, description, hostname, worker_name, tier, manifest, status)
      VALUES ('a1', '${org}', 'todo', 'Todo', 'Todo', 'todo-default.thecomeup.cc', 'every-todo', 'service_binding', '{"id":"todo"}', 'active'),
             ('a2', '${org}', 'chef', 'Chef', 'Chef', 'chef-default.thecomeup.cc', 'every-chef', 'service_binding', '{"id":"chef"}', 'active');
  `);
  account.workers.set("every-app-gateway", {
    versions: ["wrangler-version"],
    config: { name: "every-app-gateway", env: {}, domains: [HOST] },
    secrets: { GATEWAY_URL: `https://${HOST}`, BETTER_AUTH_SECRET: "s", JWT_PRIVATE_KEY: "k", JWT_PUBLIC_KEY: "p" },
  });
  account.customDomains.set(HOST, "every-app-gateway");
  for (const worker of ["every-todo", "every-chef"]) {
    account.workers.set(worker, { versions: [`${worker}-v1`], config: { name: worker, env: {} }, secrets: {} });
  }
  account.createNamespace("every-app-gateway-OAUTH_KV");
  account.dnsRecords.push({ zoneId: "zone-tcc", name: `*.${HOST}`, type: "CNAME", content: HOST });
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const db = () => cfD1Database(account.cf, databaseId);

async function upgrade(options: { interactive?: boolean; confirm?: (q: string) => Promise<boolean> } = {}) {
  const { install } = await findInstall(account.cf);
  const release = await openRelease(tarball);
  try {
    const target = await gatewayTarget({
      cf: account.cf,
      accountId: ACCOUNT_ID,
      install,
      domain: install!.gatewayHost,
      out: out(),
    });
    return await deployGatewayRelease({
      cf: account.cf,
      out: out(),
      reason: "upgrade",
      release,
      accountId: ACCOUNT_ID,
      target,
      interactive: options.interactive ?? false,
      confirm: options.confirm,
      lookupCaa: account.lookupCaa,
      certificates: { isReady: async () => true, sleep: async () => undefined },
      ...seams,
    });
  } finally {
    await release.cleanup();
  }
}

describe("adopting the gateway the wrangler-era CLI deployed", () => {
  it("refuses to deploy over it before it is adopted", async () => {
    await expect(findInstall(account.cf)).rejects.toMatchObject({
      code: "GATEWAY_NOT_ADOPTED",
      message: expect.stringContaining("everyapp gateway adopt --domain"),
    });
  });

  it("names the database in the way once the old gateway's Worker is gone", async () => {
    account.workers.delete("every-app-gateway");

    await expect(findInstall(account.cf)).rejects.toMatchObject({
      code: "GATEWAY_NOT_ADOPTED",
      message: expect.stringContaining(`cf d1 delete ${databaseId}`),
    });
  });

  it("looks before it records anything", async () => {
    const inventory = await inventoryGateway({ cf: account.cf, db: db(), accountId: ACCOUNT_ID, domain: HOST });

    expect(inventory).toMatchObject({
      zone: { id: "zone-tcc", name: HOST },
      servingVersionId: "wrangler-version",
      oauthKvId: account.namespaceId("every-app-gateway-OAUTH_KV"),
      deployKvId: null,
      wildcardRecords: [`CNAME ${HOST}`],
      drizzleMigrations: 1,
      cfMigrations: false,
      strayApps: [],
      claimed: true,
    });
    expect(describeInventory(inventory).join("\n")).toContain(
      "todo: todo-default.thecomeup.cc → every-todo (active)",
    );
    // Read-only: no install row, no namespace, no deploy.
    await expect(readInstall(db())).resolves.toBeNull();
    expect(account.namespaceId("every-app-gateway-deploy")).toBeUndefined();
    expect(account.deploys).toEqual([]);
  });

  it("keeps its route and hostnames through the upgrade, then switches to per-app domains", async () => {
    const inventory = await inventoryGateway({ cf: account.cf, db: db(), accountId: ACCOUNT_ID, domain: HOST });
    await adoptGateway({ cf: account.cf, db: db(), databaseId, accountId: ACCOUNT_ID, inventory, cliVersion: "0.3.0" });
    await expect(readInstall(db())).resolves.toMatchObject({
      gatewayHost: HOST,
      appBaseDomain: HOST,
      routing: "wildcard-route",
      releaseSha256: "legacy",
      liveVersionId: null,
      liveDomains: [HOST],
    });
    expect(account.namespaceId("every-app-gateway-deploy")).toBeTruthy();

    // A reconcile needs a release everyapp recorded: upgrade first.
    await expect(
      reconcileGateway({ cf: account.cf, out: out(), accountId: ACCOUNT_ID, interactive: false, cliVersion: "0.3.0", ...seams }),
    ).rejects.toMatchObject({ code: "UPGRADE_FIRST" });

    // Unattended, the upgrade stops before migrating: the Worker was last
    // changed through the API, and cf won't replace it without a person.
    await expect(upgrade()).rejects.toMatchObject({ action: "rerun_interactive" });
    expect(gatewayDb.all("SELECT name FROM sqlite_master WHERE name = 'd1_migrations'")).toEqual([]);

    // From a terminal it goes through: history carried over, migrated,
    // deployed with its wildcard route and the apps it had.
    const { result } = await upgrade({ interactive: true, confirm: async () => true });
    expect(result.domains).toEqual([HOST]);
    const upgraded = account.deploys.at(-1)!;
    expect(upgraded.config["triggers"]).toEqual([
      { type: "scheduled", schedule: "17 * * * *" },
      { type: "fetch", pattern: `*.${HOST}/*`, zone: "zone-tcc" },
    ]);
    expect(upgraded.config["env"].APP_BASE_DOMAIN).toBeUndefined();
    expect(account.gatewayBindings()).toEqual(["every-chef", "every-todo"]);
    expect(gatewayDb.all("SELECT app_slug, hostname, legacy_names FROM apps ORDER BY app_slug")).toEqual([
      { app_slug: "chef", hostname: "chef-default.thecomeup.cc", legacy_names: 1 },
      { app_slug: "todo", hostname: "todo-default.thecomeup.cc", legacy_names: 1 },
    ]);
    await expect(readInstall(db())).resolves.toMatchObject({
      routing: "wildcard-route",
      liveVersionId: account.workers.get("every-app-gateway")!.versions.at(-1),
    });
    // The secrets set before are kept: none were sent.
    expect(upgraded.secrets).toBeNull();

    // Reconciles work now, unattended, and keep the route.
    await expect(
      reconcileGateway({ cf: account.cf, out: out(), accountId: ACCOUNT_ID, interactive: false, cliVersion: "0.3.0", force: true, ...seams }),
    ).resolves.toMatchObject({ domains: [HOST] });

    // Switching: every app's host published as it is, checked first, and
    // said to be answered by the wildcard record now.
    events = [];
    const switched = await reconcileGateway({
      cf: account.cf,
      out: out(),
      accountId: ACCOUNT_ID,
      interactive: false,
      cliVersion: "0.3.0",
      routing: "custom-domains",
      force: true,
      lookupCaa: account.lookupCaa,
      ...seams,
    });
    expect(switched.domains).toEqual([HOST, "chef-default.thecomeup.cc", "todo-default.thecomeup.cc"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DNS_WILDCARD_ANSWERS",
        message: expect.stringContaining(`chef-default.thecomeup.cc (*.${HOST}: CNAME ${HOST})`),
        data: { hosts: ["chef-default.thecomeup.cc", "todo-default.thecomeup.cc"] },
      }),
    );
    expect(account.gatewayDomains()).toEqual([HOST, "chef-default.thecomeup.cc", "todo-default.thecomeup.cc"].sort());
    const last = account.deploys.at(-1)!;
    // The route is gone; the release's hourly housekeeping stays.
    expect(last.config["triggers"]).toEqual([
      { type: "scheduled", schedule: "17 * * * *" },
    ]);
    expect(last.config["env"].APP_BASE_DOMAIN).toEqual({ type: "text", value: HOST });
    await expect(readInstall(db())).resolves.toMatchObject({
      routing: "custom-domains",
      liveDomains: [HOST, "chef-default.thecomeup.cc", "todo-default.thecomeup.cc"],
    });
  });

  it("leaves the routing alone when the switch's checks fail", async () => {
    const inventory = await inventoryGateway({ cf: account.cf, db: db(), accountId: ACCOUNT_ID, domain: HOST });
    await adoptGateway({ cf: account.cf, db: db(), databaseId, accountId: ACCOUNT_ID, inventory, cliVersion: "0.3.0" });
    await upgrade({ interactive: true, confirm: async () => true });
    account.dnsRecords.push({ zoneId: "zone-tcc", name: "todo-default.thecomeup.cc", type: "A", content: "192.0.2.7" });

    await expect(
      reconcileGateway({
        cf: account.cf,
        out: out(),
        accountId: ACCOUNT_ID,
        interactive: false,
        cliVersion: "0.3.0",
        routing: "custom-domains",
        force: true,
        lookupCaa: account.lookupCaa,
        ...seams,
      }),
    ).rejects.toMatchObject({ code: "DNS_RECORD_CONFLICT" });
    await expect(readInstall(db())).resolves.toMatchObject({ routing: "wildcard-route" });
    expect(account.gatewayDomains()).toEqual([HOST]);
  });

  it("leaves the routing alone when cf stops before publishing the app hostnames", async () => {
    const inventory = await inventoryGateway({ cf: account.cf, db: db(), accountId: ACCOUNT_ID, domain: HOST });
    await adoptGateway({ cf: account.cf, db: db(), databaseId, accountId: ACCOUNT_ID, inventory, cliVersion: "0.3.0" });
    await upgrade({ interactive: true, confirm: async () => true });
    const before = (await readInstall(db()))!;
    // What `everyapp gateway use-per-app-domains` runs, from a terminal.
    const switchToPerAppDomains = () =>
      reconcileGateway({
        cf: account.cf,
        out: out(),
        accountId: ACCOUNT_ID,
        interactive: true,
        cliVersion: "0.3.0",
        routing: "custom-domains",
        force: true,
        lookupCaa: account.lookupCaa,
        ...seams,
      });

    // cf puts the new version live, then skips the Custom Domains (a move
    // declined at its prompt; the zone's limit or an API error stop it the
    // same way) and exits 1.
    const hosts = [HOST, "chef-default.thecomeup.cc", "todo-default.thecomeup.cc"];
    account.afterUpload = (worker) =>
      worker === "every-app-gateway" ? customDomainsSkipped(worker, hosts) : undefined;
    await expect(switchToPerAppDomains()).rejects.toThrow("only partially updated");
    account.afterUpload = null;

    // Only the version is recorded: the install is on its wildcard route
    // still, so running the switch again does it rather than saying it's done.
    await expect(readInstall(db())).resolves.toEqual({
      ...before,
      liveVersionId: account.workers.get("every-app-gateway")!.versions.at(-1),
      updatedAt: expect.any(Number),
      updatedBy: expect.any(String),
    });
    expect(account.gatewayDomains()).toEqual([HOST]);

    await switchToPerAppDomains();
    await expect(readInstall(db())).resolves.toMatchObject({
      routing: "custom-domains",
      liveDomains: hosts,
    });
    expect(account.gatewayDomains()).toEqual([...hosts].sort());
  });
});

describe("checking the domain serves this account's gateway", () => {
  const inventory = { servingVersionId: "wrangler-version", claimed: true };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const html = (status: number) => new Response("<!doctype html><title>Acme</title>", { status });
  /** What https://<HOST> answers, by path. */
  function serves(paths: Record<string, () => Response>) {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      return (paths[path] ?? (() => html(404)))();
    });
    return asked;
  }
  const check = () => assertServesGateway({ domain: HOST, inventory });

  afterEach(() => vi.unstubAllGlobals());

  it("takes a host that answers from the version this account's Worker serves", async () => {
    serves({ "/api/deploy/status": () => json({ release: null, versionId: "wrangler-version", appBindingsDigest: "x" }) });
    await expect(check()).resolves.toBe("version");
  });

  it("takes a gateway from before /api/deploy/status whose owner matches this account's database", async () => {
    const asked = serves({ "/api/admin/has-owner": () => json({ hasOwner: true }) });
    await expect(check()).resolves.toBe("owner");
    expect(asked).toEqual(["/api/deploy/status", "/api/admin/has-owner"]);
  });

  it("refuses a host that isn't this account's gateway, recording nothing", async () => {
    // Another account's gateway.
    serves({ "/api/deploy/status": () => json({ release: null, versionId: "elsewhere", appBindingsDigest: "x" }) });
    await expect(check()).rejects.toMatchObject({
      code: "DOMAIN_NOT_GATEWAY",
      message: expect.stringContaining("from version elsewhere"),
    });
    // The company's website: pages, no gateway API.
    serves({});
    await expect(check()).rejects.toMatchObject({ code: "DOMAIN_NOT_GATEWAY" });
    serves({ "/api/deploy/status": () => html(200), "/api/admin/has-owner": () => html(200) });
    await expect(check()).rejects.toMatchObject({ code: "DOMAIN_NOT_GATEWAY" });
    // A gateway nobody claimed, when this account's has its owner.
    serves({ "/api/admin/has-owner": () => json({ hasOwner: false }) });
    await expect(check()).rejects.toMatchObject({
      code: "DOMAIN_NOT_GATEWAY",
      message: expect.stringContaining("has no owner yet"),
    });
    await expect(readInstall(db())).resolves.toBeNull();
  });

  it("says when the host doesn't answer at all", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(check()).rejects.toMatchObject({ code: "GATEWAY_UNREACHABLE", retryable: true });
  });
});
