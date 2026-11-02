/**
 * `everyapp deploy` and `delete --purge` of an app declaring Cloudflare
 * Artifacts (`resources.artifacts`), end to end in the fake Cloudflare
 * account (test/fakeCloudflare.ts): Artifacts makes a namespace with its
 * first repo, so the deploy creates nothing, and records each namespace,
 * `<worker>--<binding>`, in the resource ledger; the build binds
 * `{ type: "artifacts", namespace }` on the app's Worker and every helper
 * (the install rewrites the placeholder Worker name in it); the policy lets
 * the binding through only under a name the manifest declares and only to
 * its own namespace; `delete --purge` deletes the namespace's repos, then
 * the namespace. Whether Cloudflare takes the binding is for a live check.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources, recordOwnedResource } from "@/lib/app/ownership";
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

const APP_WORKER = "every-acme-birds";
const HELPER = "every-acme-birds--hub";
const MEMORY_NS = "every-acme-birds--memory";
const FILES_NS = "every-acme-birds--agent-files";

const BIRDS: EveryAppCliManifest = {
  id: "birds",
  resources: {
    d1: ["DB"],
    artifacts: [{ name: "MEMORY" }, { name: "AGENT_FILES" }],
  },
  workers: [{ name: "hub", binding: "HUB" }],
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: any[];

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-artifacts-app-"));
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

function deploy(manifest: EveryAppCliManifest = BIRDS) {
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
    appId: "birds",
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

/** The app's ledger rows of kind `artifacts`, as [binding, name, id]. */
const namespaces = async () =>
  (await readOwnedResources(registry(), APP_WORKER))
    .filter((resource) => resource.kind === "artifacts")
    .map((resource) => [resource.binding, resource.name, resource.resourceId]);

const uploads = () =>
  account.deploys.filter((upload) => upload.workerName.startsWith(APP_WORKER));

const artifactsCalls = () => account.cf.calls.filter((call) => call.args[0] === "artifacts");

const MEMORY = { type: "artifacts", namespace: MEMORY_NS };
const AGENT_FILES = { type: "artifacts", namespace: FILES_NS };

describe("deploy of an app declaring Artifacts", () => {
  it("binds each namespace on the app's Worker and its helper, creates nothing, and records each namespace", async () => {
    await deploy();

    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(APP_WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["MEMORY"]).toEqual(MEMORY);
      expect(upload.config["env"]["AGENT_FILES"]).toEqual(AGENT_FILES);
    }
    // Artifacts makes a namespace with its first repo: nothing is created,
    // and each namespace is only looked up, to refuse one someone else made.
    expect(artifactsCalls().every((call) => call.args[2] === "get")).toBe(true);
    expect(new Set(artifactsCalls().map((call) => call.args[3]))).toEqual(new Set([MEMORY_NS, FILES_NS]));
    await expect(namespaces()).resolves.toEqual([
      ["AGENT_FILES", FILES_NS, FILES_NS],
      ["MEMORY", MEMORY_NS, MEMORY_NS],
    ]);
  });

  it("binds and records them the same way on a redeploy", async () => {
    await deploy();
    // A redeploy records the Workers' new versions; everything else stays.
    const stable = async () =>
      (await readOwnedResources(registry(), APP_WORKER)).map(({ kind, binding, name, resourceId }) => [
        kind,
        binding,
        name,
        resourceId,
      ]);
    const owned = await stable();
    account.deploys.length = 0;

    await deploy();

    const [helper, app] = uploads();
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["MEMORY"]).toEqual(MEMORY);
    }
    await expect(stable()).resolves.toEqual(owned);
  });

  it("refuses, and records nothing for, a namespace that already exists unrecorded: a purge would delete repos the app never made", async () => {
    account.addArtifactsRepo(MEMORY_NS, "someone-elses");

    await expect(deploy()).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining(`An Artifacts namespace named "${MEMORY_NS}" already exists in this Cloudflare account`),
    });
    expect(uploads()).toEqual([]);
    await expect(namespaces()).resolves.toEqual([]);
    expect(account.artifacts.get(MEMORY_NS)).toEqual(new Set(["someone-elses"]));
  });

  it("binds a namespace it recorded on a redeploy, once the app has made repos in it", async () => {
    await deploy();
    account.addArtifactsRepo(MEMORY_NS, "agent-1");
    account.deploys.length = 0;

    await deploy();

    expect(uploads().length).toBe(2);
    await expect(namespaces()).resolves.toEqual([
      ["AGENT_FILES", FILES_NS, FILES_NS],
      ["MEMORY", MEMORY_NS, MEMORY_NS],
    ]);
  });

  it("refuses a namespace another app recorded, before anything is uploaded", async () => {
    await recordOwnedResource(registry(), "every-acme-other", {
      kind: "artifacts",
      binding: "SHARED",
      name: MEMORY_NS,
      resourceId: MEMORY_NS,
    });

    await expect(deploy()).rejects.toMatchObject({
      code: "RESOURCE_OWNED",
      message: expect.stringContaining(`Artifacts namespace "${MEMORY_NS}" is recorded as another app's`),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses a namespace longer than Cloudflare's 63 characters, before anything is created or uploaded", async () => {
    const binding = "M".repeat(50);
    await expect(
      deploy({ ...BIRDS, resources: { d1: ["DB"], artifacts: [{ name: binding }] } }),
    ).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        `resources.artifacts: ${binding} would be the Artifacts namespace "${APP_WORKER}--${binding.toLowerCase()}", which Cloudflare refuses (at most 63 characters)`,
      ),
    });
    expect(uploads()).toEqual([]);
    expect(account.databases.size).toBe(1);
  });

  it("refuses an Artifacts binding the manifest doesn't declare", async () => {
    account.editBuild = (config) => (config["env"]["MEMORY"] = { type: "artifacts", namespace: MEMORY_NS });
    const { artifacts: _artifacts, ...resources } = BIRDS.resources!;

    await expect(deploy({ ...BIRDS, resources })).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        "MEMORY is an Artifacts binding, which everyapp.config.ts doesn't declare; list it in resources.artifacts",
      ),
    });
    expect(uploads()).toEqual([]);
  });

  it("refuses a declared binding cloudflare.config.ts points at another app's namespace", async () => {
    account.editBuild = (config) => (config["env"]["MEMORY"]["namespace"] = "every-acme-other--memory");

    await expect(deploy()).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        `MEMORY is Artifacts namespace "every-acme-other--memory"; an app's namespace is named after its Worker (${MEMORY_NS})`,
      ),
    });
    expect(uploads()).toEqual([]);
  });
});

describe("delete --purge of an app declaring Artifacts", () => {
  it("deletes each recorded namespace's repos, then the namespace, and forgets them", async () => {
    await deploy();
    for (const repo of ["agent-1", "agent-2", "principles"]) account.addArtifactsRepo(MEMORY_NS, repo);
    // Another app's namespace, named like nothing of this one's.
    account.addArtifactsRepo("every-acme-other--memory", "keep-me");

    await purge();

    expect(account.artifacts.has(MEMORY_NS)).toBe(false);
    expect(account.artifacts.get("every-acme-other--memory")).toEqual(new Set(["keep-me"]));
    const step = events.find((event) => event.step === "app.purge" && event.status === "ok");
    expect(step!.data.removed).toContain(`Artifacts namespace "${MEMORY_NS}"`);
    // AGENT_FILES never had a repo, so Artifacts never made it: nothing to delete.
    expect(step!.data.removed).not.toContain(`Artifacts namespace "${FILES_NS}"`);
    expect(step!.data.kinds).toContain("Artifacts namespace");
    expect(events.some((event) => event.code === "RESOURCES_KEPT")).toBe(false);
    await expect(namespaces()).resolves.toEqual([]);
    // Every delete answered cf's confirmation.
    for (const call of artifactsCalls().filter((call) => call.args.includes("delete"))) {
      expect(call.args).toContain("--force");
    }
  });

  it("keeps, and says so, a namespace Artifacts refuses to delete", async () => {
    await deploy();
    account.addArtifactsRepo(MEMORY_NS, "agent-1");
    // A repo the list doesn't show yet (made while the purge ran).
    account.addArtifactsRepo(MEMORY_NS, "late");
    account.artifactsListLag.add("late");

    await purge();

    expect(account.artifacts.get(MEMORY_NS)).toEqual(new Set(["late"]));
    const kept = events.find((event) => event.code === "RESOURCES_KEPT");
    expect(kept!.data.kept).toContain(
      `Artifacts namespace "${MEMORY_NS}" (Artifacts refused to delete it or one of its repos)`,
    );
  });
});
