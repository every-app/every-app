/**
 * `everyapp deploy` of an app declaring Images (`resources.images`), end to
 * end in the fake Cloudflare account (test/fakeCloudflare.ts): the binding
 * is account-wide, so the deploy creates and records nothing for it; the
 * build binds `{ type: "images" }` on the app's Worker and every helper; the
 * policy lets an `images` binding through only under a name the manifest
 * declares, so cloudflare.config.ts can't add Images transformations on its
 * own. Whether Cloudflare takes the binding is the live test's
 * (test/provisioners/images.live.test.ts).
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

const APP_WORKER = "every-acme-gallery";
const HELPER = "every-acme-gallery--resize";

const CRAWLER: EveryAppCliManifest = {
  id: "gallery",
  resources: { d1: ["DB"], images: ["IMAGES"] },
  workers: [{ name: "resize", binding: "RESIZE" }],
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-images-app-"));
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

function deploy(manifest: EveryAppCliManifest = CRAWLER) {
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

describe("deploy of an app declaring Images", () => {
  it("binds it on the app's Worker and its helper, creating and recording nothing for it", async () => {
    await deploy();

    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(APP_WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["IMAGES"]).toEqual({ type: "images" });
    }
    // Account-wide: no cf command made or looked one up.
    expect(account.cf.calls.filter((call) => /^images/.test(call.args[0] ?? ""))).toEqual([]);
    // The ledger holds the database and the two Workers, nothing for Images.
    await expect(ledger()).resolves.toEqual([
      ["d1", "DB"],
      ["worker", ""],
      ["worker", "resize"],
    ]);
  });

  it("binds it the same way on a redeploy", async () => {
    await deploy();
    const owned = await ledger();
    account.deploys.length = 0;

    await deploy();

    const [helper, app] = uploads();
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["IMAGES"]).toEqual({ type: "images" });
    }
    await expect(ledger()).resolves.toEqual(owned);
  });

  it("packs a release that keeps it, and installs that release with no checkout", async () => {
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "gallery", version: "1.0.0" }));
    account.apps.set(appDir, CRAWLER);
    const { tarball } = await bundleApp({
      cwd: appDir,
      manifest: CRAWLER,
      outFile: "everyapp-release.tar.gz",
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
    });
    const release = await openAppRelease(tarball);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-images-elsewhere-"));
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
      expect(upload.config["env"]["IMAGES"]).toEqual({ type: "images" });
    }
  });

  it("refuses an images binding the manifest doesn't declare, before anything is uploaded", async () => {
    // cloudflare.config.ts adding Images transformations on its own.
    account.editBuild = (config) => (config["env"]["IMAGES"] = { type: "images" });
    const { images: _images, ...resources } = CRAWLER.resources!;

    await expect(deploy({ ...CRAWLER, resources })).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "IMAGES is an Images binding, which everyapp.config.ts doesn't declare; list it in resources.images",
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses an images binding under a name resources.images doesn't list", async () => {
    account.editBuild = (config) => (config["env"]["MORE_IMAGES"] = { type: "images" });

    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "MORE_IMAGES is an Images binding, which isn't one of the app's in resources.images (IMAGES)",
      ),
    });
    expect(uploads()).toEqual([]);
  });
});
