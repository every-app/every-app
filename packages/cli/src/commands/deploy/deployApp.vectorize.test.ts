/**
 * `everyapp deploy` and `delete --purge` of an app with Vectorize indexes
 * (`resources.vectorize`), end to end in the fake Cloudflare account
 * (test/fakeCloudflare.ts): each index created through the ledger (in
 * either form: dimensions and metric, or a preset), bound on the app's
 * Worker and its helper, found again on a redeploy, refused when it has
 * another shape or isn't the app's, deleted with the app, and never bound
 * when the deploy didn't provision it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { forgetOwnedResources, readOwnedResources } from "@/lib/app/ownership";
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
import { deployApp } from "./deployApp";

const WORKER = "every-acme-notes";
const HELPER = `${WORKER}--indexer`;
const VECTORS = `${WORKER}--vectors`;
const DOC_CHUNKS = `${WORKER}--doc-chunks`;

const NOTES: EveryAppCliManifest = {
  id: "notes",
  resources: {
    d1: ["DB"],
    vectorize: [
      { name: "VECTORS", dimensions: 768, metric: "cosine" },
      { name: "DOC_CHUNKS", preset: "@cf/baai/bge-small-en-v1.5" },
    ],
  },
  workers: [{ name: "indexer" }],
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-vectorize-app-"));
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

function deploy(manifest: EveryAppCliManifest = NOTES) {
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

const purge = () =>
  removeApp({
    appId: "notes",
    out: out(),
    interactive: false,
    purge: true,
    createCf: () => account.cf,
    reconcile: rebind,
  });

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const vectorizeCalls = (action: string) =>
  account.cf.calls.filter((call) => call.args[0] === "vectorize" && call.args[1] === action);

const appUploads = () => account.deploys.filter((upload) => upload.workerName.startsWith(WORKER));

/** The manifest with VECTORS declared otherwise. */
const withVectors = (vectors: NonNullable<NonNullable<EveryAppCliManifest["resources"]>["vectorize"]>[number]) => ({
  ...NOTES,
  resources: { ...NOTES.resources, vectorize: [vectors, NOTES.resources!.vectorize![1]!] },
});

describe("deploy of an app with Vectorize indexes", () => {
  it("creates each index in its form, records it, and binds it on the app's Worker and its helper", async () => {
    await deploy();

    expect(account.vectorizeIndexes.get(VECTORS)?.config).toEqual({ dimensions: 768, metric: "cosine" });
    expect(account.vectorizeIndexes.get(DOC_CHUNKS)?.config).toEqual({
      dimensions: 384,
      metric: "cosine",
      preset: "@cf/baai/bge-small-en-v1.5",
    });
    // Always a body file: cf reads a flag value starting with @ (the presets) as a file.
    expect(vectorizeCalls("create").map((call) => call.args)).toEqual([
      ["vectorize", "create", "--body", "@/fake-cf-files/vectorize.json"],
      ["vectorize", "create", "--body", "@/fake-cf-files/vectorize.json"],
    ]);
    expect(JSON.parse(vectorizeCalls("create")[1]!.files["vectorize.json"]!)).toEqual({
      name: DOC_CHUNKS,
      config: { preset: "@cf/baai/bge-small-en-v1.5" },
    });

    const [helper, app] = appUploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]).toMatchObject({
        VECTORS: { type: "vectorize", name: VECTORS },
        DOC_CHUNKS: { type: "vectorize", name: DOC_CHUNKS },
      });
      // No development shape reaches a deployed Worker.
      expect(upload.config["env"].VECTORS).not.toHaveProperty("dev");
    }
    const owned = await readOwnedResources(registry(), WORKER);
    expect(owned.filter((resource) => resource.kind === "vectorize")).toEqual([
      expect.objectContaining({ binding: "DOC_CHUNKS", name: DOC_CHUNKS, resourceId: DOC_CHUNKS }),
      expect.objectContaining({ binding: "VECTORS", name: VECTORS, resourceId: VECTORS }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ step: "app.resources", message: `Created Vectorize index "${VECTORS}".` }),
    );
  });

  it("creates nothing on a redeploy", async () => {
    await deploy();
    await deploy();
    expect(vectorizeCalls("create")).toHaveLength(2);
    expect(appUploads()).toHaveLength(4);
  });

  it("refuses an index of the app's whose shape the manifest changed, before anything is uploaded", async () => {
    await deploy();
    const uploads = appUploads().length;

    await expect(deploy(withVectors({ name: "VECTORS", dimensions: 1024, metric: "cosine" }))).rejects.toMatchObject({
      code: "VECTORIZE_CONFIG_MISMATCH",
      message: expect.stringContaining(
        `Vectorize index "${VECTORS}" has 768 dimensions, cosine, but everyapp.config.ts declares 1024 dimensions, cosine for VECTORS`,
      ),
      fix: "rename the binding in everyapp.config.ts to make a new one, or change VECTORS back to 768 dimensions, cosine",
    });
    await expect(deploy(withVectors({ name: "VECTORS", dimensions: 768, metric: "euclidean" }))).rejects.toMatchObject({
      code: "VECTORIZE_CONFIG_MISMATCH",
    });
    // A preset is its own shape: the index wasn't made from one.
    await expect(deploy(withVectors({ name: "VECTORS", preset: "@cf/baai/bge-base-en-v1.5" }))).rejects.toMatchObject({
      code: "VECTORIZE_CONFIG_MISMATCH",
      message: expect.stringContaining("declares the preset @cf/baai/bge-base-en-v1.5 for VECTORS"),
    });
    expect(appUploads()).toHaveLength(uploads);
    expect(account.vectorizeIndexes.get(VECTORS)?.config).toEqual({ dimensions: 768, metric: "cosine" });
    expect(vectorizeCalls("create")).toHaveLength(2);
    expect(vectorizeCalls("delete")).toEqual([]);
  });

  it("refuses an index of the app's name that no deploy of it recorded, whatever its shape", async () => {
    account.vectorizeIndexes.set(VECTORS, {
      config: { dimensions: 768, metric: "cosine" },
      created_on: "2026-10-01T00:00:00.000Z",
    });

    await expect(deploy()).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining(`A Vectorize index named "${VECTORS}" already exists in this Cloudflare account`),
    });
    expect(appUploads()).toEqual([]);
    expect(vectorizeCalls("create")).toEqual([]);
    const owned = await readOwnedResources(registry(), WORKER);
    expect(owned.filter((resource) => resource.kind === "vectorize")).toEqual([]);
  });

  it("creates the index again, empty, when the one it recorded was deleted", async () => {
    await deploy();
    account.vectorizeIndexes.delete(VECTORS);

    await deploy();
    expect(account.vectorizeIndexes.has(VECTORS)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "RESOURCE_RECREATED", step: "app.resources" }),
    );
  });

  it("refuses an index name longer than Cloudflare's 64 characters, before anything is created", async () => {
    const binding = "V".repeat(64 - `${WORKER}--`.length + 1);
    await expect(
      deploy({ ...NOTES, resources: { d1: ["DB"], vectorize: [{ name: binding, dimensions: 768, metric: "cosine" }] } }),
    ).rejects.toMatchObject({
      code: "VECTORIZE_NAME_TOO_LONG",
      message: expect.stringContaining(`longer than Cloudflare's 64 characters`),
      fix: "shorten its binding name in everyapp.config.ts",
    });
    expect(vectorizeCalls("create")).toEqual([]);
    expect(vectorizeCalls("get")).toEqual([]);
  });

  it("refuses a vectorize binding to an index the deploy didn't provision", async () => {
    await deploy();
    const uploads = appUploads().length;
    for (const index of ["someone-elses-index", `${WORKER}--other`]) {
      account.editBuild = (config) => {
        config["env"].STOLEN = { type: "vectorize", name: index };
      };
      await expect(deploy()).rejects.toMatchObject({
        code: "APP_POLICY",
        message: expect.stringContaining(
          `STOLEN is Vectorize index "${index}", which isn't one the deploy provisioned`,
        ),
      });
    }
    // Nor one the manifest doesn't declare, by an app with none.
    account.editBuild = (config) => {
      config["env"].STOLEN = { type: "vectorize", name: VECTORS };
    };
    await expect(deploy({ ...NOTES, resources: { d1: ["DB"] } })).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(`STOLEN is Vectorize index "${VECTORS}"`),
    });
    expect(appUploads()).toHaveLength(uploads);
  });

  it("deletes the app's indexes on --purge, and keeps one of its names it never recorded", async () => {
    await deploy();
    // As if VECTORS had been made by hand: the purge can't know it is the app's.
    await forgetOwnedResources(registry(), WORKER, { kind: "vectorize", binding: "VECTORS" });

    const result = await purge();

    expect([...account.vectorizeIndexes.keys()]).toEqual([VECTORS]);
    expect(result.purged?.removed).toContain(`Vectorize index "${DOC_CHUNKS}"`);
    expect(result.purged?.kept).toEqual([`Vectorize index "${VECTORS}"`]);
    expect(vectorizeCalls("delete").map((call) => call.args)).toEqual([
      ["vectorize", "delete", DOC_CHUNKS, "--force"],
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "warning",
        code: "RESOURCES_KEPT",
        message: expect.stringContaining(`the Vectorize index ${VECTORS}`),
        data: expect.objectContaining({ fix: expect.stringContaining("AI → Vectorize") }),
      }),
    );
  });

  it("deletes every recorded index on --purge, and finds nothing left", async () => {
    await deploy();
    const result = await purge();
    expect(account.vectorizeIndexes.size).toBe(0);
    expect(result.purged?.removed).toEqual(
      expect.arrayContaining([`Vectorize index "${VECTORS}"`, `Vectorize index "${DOC_CHUNKS}"`]),
    );
    expect(result.purged?.kept).toEqual([]);
  });
});
