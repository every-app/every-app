/**
 * `everyapp deploy` of an app declaring Workers AI (`resources.ai`), end to
 * end in the fake Cloudflare account (test/fakeCloudflare.ts): the binding
 * is account-wide, so the deploy creates and records nothing for it; the
 * build binds `{ type: "ai" }` on the app's Worker and every helper; the
 * policy lets an `ai` binding through only under a name the manifest
 * declares, so cloudflare.config.ts can't add account-wide inference on its
 * own. Whether a call reaches the model is the live test's
 * (test/provisioners/ai.live.test.ts).
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

const APP_WORKER = "every-acme-assistant";
const HELPER = "every-acme-assistant--embed";

const ASSISTANT: EveryAppCliManifest = {
  id: "assistant",
  resources: { d1: ["DB"], ai: ["AI"] },
  workers: [{ name: "embed", binding: "EMBED" }],
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-ai-app-"));
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

function deploy(manifest: EveryAppCliManifest = ASSISTANT) {
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

describe("deploy of an app declaring Workers AI", () => {
  it("binds it on the app's Worker and its helper, creating and recording nothing for it", async () => {
    await deploy();

    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(APP_WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["AI"]).toEqual({ type: "ai" });
    }
    // Account-wide: no cf command made or looked one up.
    expect(account.cf.calls.filter((call) => call.args[0] === "ai")).toEqual([]);
    // The ledger holds the database and the two Workers, nothing for AI.
    await expect(ledger()).resolves.toEqual([
      ["d1", "DB"],
      ["worker", ""],
      ["worker", "embed"],
    ]);
  });

  it("binds it the same way on a redeploy", async () => {
    await deploy();
    const owned = await ledger();
    account.deploys.length = 0;

    await deploy();

    const [helper, app] = uploads();
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["AI"]).toEqual({ type: "ai" });
    }
    await expect(ledger()).resolves.toEqual(owned);
  });

  it("packs a release that keeps it, and installs that release with no checkout", async () => {
    fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "assistant", version: "1.0.0" }));
    account.apps.set(appDir, ASSISTANT);
    const { tarball } = await bundleApp({
      cwd: appDir,
      manifest: ASSISTANT,
      outFile: "everyapp-release.tar.gz",
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
    });
    const release = await openAppRelease(tarball);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-ai-elsewhere-"));
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
      expect(upload.config["env"]["AI"]).toEqual({ type: "ai" });
    }
  });

  it("refuses an ai binding the manifest doesn't declare, before anything is uploaded", async () => {
    // cloudflare.config.ts adding account-wide inference on its own.
    account.editBuild = (config) => (config["env"]["AI"] = { type: "ai" });
    const { ai: _ai, ...resources } = ASSISTANT.resources!;

    await expect(deploy({ ...ASSISTANT, resources })).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "AI is a Workers AI binding, which everyapp.config.ts doesn't declare; list it in resources.ai",
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses an ai binding under a name resources.ai doesn't list", async () => {
    account.editBuild = (config) => (config["env"]["MORE_AI"] = { type: "ai" });

    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "MORE_AI is a Workers AI binding, which isn't one of the app's in resources.ai (AI)",
      ),
    });
    expect(uploads()).toEqual([]);
  });
});
