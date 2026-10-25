/**
 * `everyapp deploy` of an app declaring Analytics Engine datasets
 * (`resources.analyticsEngine`), end to end in the fake Cloudflare account
 * (test/fakeCloudflare.ts): a dataset exists once written to, so the deploy
 * creates and records nothing for it; the build binds
 * `{ type: "analytics-engine-dataset", name }` on the app's Worker and every
 * helper, the name the manifest's `dataset` or `<worker>--<binding>` (the
 * install rewrites the placeholder Worker name in it); the policy lets the
 * binding through only under a name the manifest declares and only to the
 * dataset it declares. Whether Cloudflare takes the binding is the live
 * test's (test/provisioners/analytics-engine.live.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOwnedResources } from "@/lib/app/ownership";
import { openAppRelease } from "@/lib/app/release";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { bundleApp } from "../release/bundleApp";
import { deployApp } from "./deployApp";

const APP_WORKER = "every-acme-shop";
const HELPER = "every-acme-shop--ingest";

const SHOP: EveryAppCliManifest = {
  id: "shop",
  resources: {
    d1: ["DB"],
    analyticsEngine: [{ name: "EVENTS" }, { name: "AUDIT", dataset: "audit_log" }],
  },
  workers: [{ name: "ingest", binding: "INGEST" }],
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(tarball),
  source: () => releaseSource(tarball),
};

beforeEach(async () => {
  events = [];
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-analytics-app-"));
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

function deploy(manifest: EveryAppCliManifest = SHOP) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

/** The app's ledger rows, by kind and binding. */
const ledger = async () =>
  (await readOwnedResources(registry(), APP_WORKER)).map((resource) => [
    resource.kind,
    resource.binding,
  ]);

const uploads = () =>
  account.deploys.filter((upload) => upload.workerName.startsWith(APP_WORKER));

const EVENTS = { type: "analytics-engine-dataset", name: "every-acme-shop--events" };
const AUDIT = { type: "analytics-engine-dataset", name: "audit_log" };

describe("deploy of an app declaring Analytics Engine datasets", () => {
  it("binds them on the app's Worker and its helper, the default named after the app's Worker, creating and recording nothing for them", async () => {
    await deploy();

    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(APP_WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["EVENTS"]).toEqual(EVENTS);
      expect(upload.config["env"]["AUDIT"]).toEqual(AUDIT);
    }
    // A dataset exists once written to: no cf command made or looked one up.
    expect(account.cf.calls.filter((call) => /^analytics/.test(call.args[0] ?? ""))).toEqual([]);
    await expect(ledger()).resolves.toEqual([
      ["d1", "DB"],
      ["worker", ""],
      ["worker", "ingest"],
    ]);
  });

  it("binds them the same way on a redeploy", async () => {
    await deploy();
    const owned = await ledger();
    account.deploys.length = 0;

    await deploy();

    const [helper, app] = uploads();
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["EVENTS"]).toEqual(EVENTS);
      expect(upload.config["env"]["AUDIT"]).toEqual(AUDIT);
    }
    await expect(ledger()).resolves.toEqual(owned);
  });

  it("packs a release that keeps them, and installs that release under the install's own Worker name", async () => {
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "shop", version: "1.0.0" }));
    account.apps.set(appDir, SHOP);
    const { tarball } = await bundleApp({
      cwd: appDir,
      manifest: SHOP,
      outFile: "everyapp-release.tar.gz",
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
    });
    const release = await openAppRelease(tarball);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-analytics-elsewhere-"));
    try {
      await deployApp({
        cwd: elsewhere,
        release,
        out: out(),
        createCf: () => account.cf,
        installDeps: async () => undefined,
        reconcile: rebind,
        live: { fetch: worker.fetch, sleep: async () => undefined },
      });
    } finally {
      await release.cleanup();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }

    const [helper, app] = uploads();
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["EVENTS"]).toEqual(EVENTS);
      expect(upload.config["env"]["AUDIT"]).toEqual(AUDIT);
    }
  });

  it("refuses a dataset binding the manifest doesn't declare, before anything is uploaded", async () => {
    account.editBuild = (config) =>
      (config["env"]["EVENTS"] = { type: "analytics-engine-dataset", name: "every-acme-shop--events" });
    const { analyticsEngine: _datasets, ...resources } = SHOP.resources!;

    await expect(deploy({ ...SHOP, resources })).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "EVENTS is an Analytics Engine binding, which everyapp.config.ts doesn't declare; list it in resources.analyticsEngine",
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses one under a name resources.analyticsEngine doesn't list", async () => {
    account.editBuild = (config) =>
      (config["env"]["MORE"] = { type: "analytics-engine-dataset", name: "every-acme-shop--more" });

    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "MORE is an Analytics Engine binding, which isn't one of the app's in resources.analyticsEngine (EVENTS, AUDIT)",
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses a declared binding cloudflare.config.ts points at another dataset", async () => {
    account.editBuild = (config) => (config["env"]["EVENTS"]["name"] = "every-other-shop--events");

    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        'EVENTS writes to dataset "every-other-shop--events", not "every-acme-shop--events", which resources.analyticsEngine declares',
      ),
    });
    expect(uploads()).toEqual([]);
  });
});
