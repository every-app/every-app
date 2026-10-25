/**
 * `everyapp deploy` and `delete --purge` of an app with an AI Gateway of
 * its own (`resources.aiGateway`), end to end in the fake Cloudflare
 * account (test/fakeCloudflare.ts): the gateway created through the
 * resource ledger as `<worker>-<binding>`, bound on the app's Worker and
 * its helper as a json binding of `{ id, accountId, url }`, found again on
 * a redeploy, refused when the id is someone else's, set back to the
 * manifest's logging and caching, and deleted with the app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resourceSentinel } from "@every-app/sdk/cloudflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeApp } from "@/commands/delete";
import { readOwnedResources } from "@/lib/app/ownership";
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
const HELPER = "every-acme-notes--digest";
const GATEWAY = "every-acme-notes-ai-gateway";
const URL_ = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY}`;

const NOTES: EveryAppCliManifest = {
  id: "notes",
  resources: { d1: ["DB"], aiGateway: [{ name: "AI_GATEWAY" }] },
  workers: [{ name: "digest" }],
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-ai-gateway-app-"));
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

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const gatewayCalls = (action: string) =>
  account.cf.calls.filter((call) => call.args[0] === "ai-gateway" && call.args[2] === action);

const uploads = () =>
  account.deploys.filter((upload) => upload.workerName.startsWith(WORKER));

describe("deploy of an app with an AI Gateway of its own", () => {
  it("creates the gateway, records it, and binds its id, account and URL on every Worker", async () => {
    await deploy();

    expect(account.aiGateways.get(GATEWAY)).toMatchObject({
      id: GATEWAY,
      collect_logs: true,
      cache_ttl: 0,
      authentication: false,
    });
    const [helper, app] = uploads();
    expect(helper!.workerName).toBe(HELPER);
    expect(app!.workerName).toBe(WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]["AI_GATEWAY"]).toEqual({
        type: "json",
        value: { id: GATEWAY, accountId: ACCOUNT_ID, url: URL_ },
      });
    }
    // No placeholder of the build survives anywhere in what was uploaded.
    expect(JSON.stringify(app!.config)).not.toContain("sentinel");
    await expect(readOwnedResources(registry(), WORKER)).resolves.toContainEqual(
      expect.objectContaining({
        kind: "ai-gateway",
        binding: "AI_GATEWAY",
        name: GATEWAY,
        resourceId: GATEWAY,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "progress",
        step: "app.resources",
        message: `Created AI Gateway "${GATEWAY}".`,
      }),
    );
  });

  it("creates the gateway with the manifest's logging and caching", async () => {
    await deploy({
      ...NOTES,
      resources: { d1: ["DB"], aiGateway: [{ name: "AI_GATEWAY", collectLogs: false, cacheTtl: 600 }] },
    });
    expect(account.aiGateways.get(GATEWAY)).toMatchObject({ collect_logs: false, cache_ttl: 600 });
  });

  it("finds its gateway again on a redeploy and creates nothing", async () => {
    await deploy();
    await deploy();

    expect(gatewayCalls("create")).toHaveLength(1);
    expect(gatewayCalls("update")).toEqual([]);
    expect(account.aiGateways.size).toBe(1);
    expect(uploads().at(-1)!.config["env"]["AI_GATEWAY"]["value"]).toEqual({
      id: GATEWAY,
      accountId: ACCOUNT_ID,
      url: URL_,
    });
  });

  it("refuses a gateway of its id that no deploy of it recorded, before anything is uploaded", async () => {
    account.aiGateways.set(GATEWAY, { id: GATEWAY, collect_logs: true, cache_ttl: 0 });

    await expect(deploy()).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining(`An AI Gateway named "${GATEWAY}" already exists`),
    });
    expect(uploads()).toEqual([]);
    expect(gatewayCalls("create")).toEqual([]);
    expect(gatewayCalls("update")).toEqual([]);
  });

  it("sets its gateway back to the manifest's logging and caching when they changed, and says so", async () => {
    await deploy();
    events = [];
    await deploy({
      ...NOTES,
      resources: { d1: ["DB"], aiGateway: [{ name: "AI_GATEWAY", collectLogs: false, cacheTtl: 3600 }] },
    });

    expect(account.aiGateways.get(GATEWAY)).toMatchObject({ collect_logs: false, cache_ttl: 3600 });
    expect(gatewayCalls("update")).toHaveLength(1);
    const messages = events
      .filter((event) => event["step"] === "app.resources" && event["type"] === "progress")
      .map((event) => event["message"]);
    expect(messages).toEqual(
      expect.arrayContaining([
        `Turned off request logs on AI Gateway "${GATEWAY}" (collectLogs: false).`,
        `Set AI Gateway "${GATEWAY}" to cache responses for 3600 s (cacheTtl).`,
      ]),
    );

    // Changed in the dashboard since: set back to the manifest's.
    Object.assign(account.aiGateways.get(GATEWAY)!, { collect_logs: true });
    await deploy({
      ...NOTES,
      resources: { d1: ["DB"], aiGateway: [{ name: "AI_GATEWAY", collectLogs: false, cacheTtl: 3600 }] },
    });
    expect(account.aiGateways.get(GATEWAY)).toMatchObject({ collect_logs: false });
    expect(gatewayCalls("update")).toHaveLength(2);
  });

  it("creates a new gateway, with a warning, when the one it recorded was deleted", async () => {
    await deploy();
    account.aiGateways.delete(GATEWAY);
    events = [];
    await deploy();

    expect(account.aiGateways.has(GATEWAY)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "RESOURCE_RECREATED" }),
    );
  });

  it("leaves the app's own json bindings as they are", async () => {
    account.editBuild = (config) => {
      config["env"]["FEATURES"] = { type: "json", value: { id: "plan", tier: "pro" } };
      config["env"]["LIMITS"] = { type: "json", value: [1, 2, 3] };
      config["env"]["MOTTO"] = { type: "json", value: "hello" };
    };
    await deploy();

    const env = uploads().at(-1)!.config["env"];
    expect(env["FEATURES"]).toEqual({ type: "json", value: { id: "plan", tier: "pro" } });
    expect(env["LIMITS"]).toEqual({ type: "json", value: [1, 2, 3] });
    expect(env["MOTTO"]).toEqual({ type: "json", value: "hello" });
    expect(env["AI_GATEWAY"]["value"]["id"]).toBe(GATEWAY);
  });

  it("refuses a gateway placeholder for a binding the manifest doesn't declare", async () => {
    account.editBuild = (config) => {
      config["env"]["SHADOW"] = {
        type: "json",
        value: { id: resourceSentinel("SHADOW"), accountId: "x", url: "y" },
      };
    };
    await expect(deploy()).rejects.toMatchObject({ code: "INSTALL_INPUTS_MISSING" });
    expect(uploads()).toEqual([]);
  });

  it("deletes the gateway with the app on --purge", async () => {
    await deploy();
    const result = await removeApp({
      appId: "notes",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });

    expect(account.aiGateways.size).toBe(0);
    expect(result.purged?.removed).toContain(`AI Gateway "${GATEWAY}"`);
    expect(result.purged?.kept).toEqual([]);
    expect(gatewayCalls("delete")[0]!.args).toEqual([
      "ai-gateway",
      "gateways",
      "delete",
      GATEWAY,
      "--force",
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.purge",
        status: "ok",
        data: expect.objectContaining({ kinds: expect.arrayContaining(["AI Gateway"]) }),
      }),
    );
  });

  it("purges an app whose gateway was deleted by hand already", async () => {
    await deploy();
    account.aiGateways.delete(GATEWAY);
    const result = await removeApp({
      appId: "notes",
      out: out(),
      interactive: false,
      purge: true,
      createCf: () => account.cf,
      reconcile: rebind,
    });
    expect(result.purged?.removed).not.toContain(`AI Gateway "${GATEWAY}"`);
    await expect(readOwnedResources(registry(), WORKER)).resolves.toEqual([]);
  });
});
