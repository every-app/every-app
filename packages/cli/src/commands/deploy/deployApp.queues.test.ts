/**
 * `everyapp deploy` and `delete --purge` of apps with Cloudflare Queues
 * (`resources.queues`), end to end in the fake Cloudflare account
 * (test/fakeCloudflare.ts): each queue created and recorded as the app's
 * before the build is installed, its producer binding on every Worker of
 * the app, each consumer trigger (and its dead-letter queue) on the Worker
 * that consumes, the consumers cf publishes with the upload, nothing made
 * again on a redeploy, a queue of the app's name that no deploy recorded
 * refused, the queues deleted with the app (their consumers first), and
 * the policy's refusal of a queue the deploy didn't provision.
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
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

/** A producer only: the app sends, nothing in the app consumes. */
const MAIL: EveryAppCliManifest = {
  id: "mail",
  resources: { d1: ["DB"], queues: [{ name: "EMAILS" }] },
};
const EMAILS = "every-acme-mail--emails";

/** A consumer on the app's Worker, and one on a helper with a dead-letter queue. */
const CRAWL: EveryAppCliManifest = {
  id: "crawl",
  resources: {
    queues: [
      { name: "JOBS", consumer: true },
      {
        name: "CRAWLS",
        consumer: { worker: "crawler", maxBatchSize: 5, maxRetries: 2, deadLetterQueue: "FAILED_CRAWLS" },
      },
      { name: "FAILED_CRAWLS" },
    ],
  },
  workers: [{ name: "crawler" }],
};
const CRAWL_WORKER = "every-acme-crawl";
const CRAWLER = "every-acme-crawl--crawler";
const JOBS = "every-acme-crawl--jobs";
const CRAWLS = "every-acme-crawl--crawls";
const FAILED = "every-acme-crawl--failed-crawls";

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-queues-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  events = [];
  // What the Gateway's install did (its activation queue among it) isn't the app's.
  account.cf.calls.length = 0;
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function deploy(manifest: EveryAppCliManifest) {
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

function purge(appId: string) {
  return removeApp({
    appId,
    out: out(),
    interactive: false,
    purge: true,
    createCf: () => account.cf,
    reconcile: rebind,
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );

const queueCalls = (...action: string[]) =>
  account.cf.calls.filter(
    (call) => call.args[0] === "queues" && action.every((arg, index) => call.args[index + 1] === arg),
  );

/** The account's queues but the Gateway's own activation queue (setup made it; the app never touches it). */
const appQueues = () =>
  [...account.queues.values()].filter((queue) => queue.name !== "every-app-gateway-activate").length;

const uploads = (worker: string) => account.deploys.filter((upload) => upload.workerName === worker);

const consumersOf = (name: string) => [...account.queue(name)!.consumers.values()];

describe("deploy of an app with Queues", () => {
  it("creates and records a producer's queue, and binds it on the app's Worker", async () => {
    await deploy(MAIL);

    const queue = account.queue(EMAILS)!;
    expect(queue).toBeDefined();
    expect(queueCalls("create")[0]!.args).toEqual(["queues", "create", "--queue-name", EMAILS]);
    const [upload] = uploads("every-acme-mail");
    expect(upload!.config["env"].EMAILS).toEqual({ type: "queue", name: EMAILS });
    expect(upload!.config["triggers"]).toBeUndefined();
    expect(queue.consumers.size).toBe(0);
    // Uploaded so cf makes nothing a binding names.
    expect(upload!.args).toContain("--no-provision");
    await expect(readOwnedResources(registry(), "every-acme-mail")).resolves.toContainEqual(
      expect.objectContaining({ kind: "queue", binding: "EMAILS", name: EMAILS, resourceId: queue.id }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ step: "app.resources", message: `Created Queue "${EMAILS}".` }),
    );
  });

  it("binds every queue on every Worker, and gives each consumer trigger to the Worker that consumes", async () => {
    await deploy(CRAWL);

    const [helper] = uploads(CRAWLER);
    const [app] = uploads(CRAWL_WORKER);
    for (const upload of [helper!, app!]) {
      expect(upload.config["env"]).toMatchObject({
        JOBS: { type: "queue", name: JOBS },
        CRAWLS: { type: "queue", name: CRAWLS },
        FAILED_CRAWLS: { type: "queue", name: FAILED },
      });
    }
    expect(app!.config["triggers"]).toEqual([{ type: "queue", name: JOBS }]);
    expect(helper!.config["triggers"]).toEqual([
      { type: "queue", name: CRAWLS, deadLetterQueue: FAILED, maxBatchSize: 5, maxRetries: 2 },
    ]);
    // cf publishes each consumer with the upload; nothing else asks it to.
    expect(consumersOf(JOBS)).toEqual([expect.objectContaining({ script: CRAWL_WORKER })]);
    expect(consumersOf(CRAWLS)).toEqual([
      expect.objectContaining({ script: CRAWLER, deadLetterQueue: FAILED }),
    ]);
    expect(consumersOf(FAILED)).toEqual([]);
    expect(queueCalls("consumers")).toEqual([]);
    const owned = await readOwnedResources(registry(), CRAWL_WORKER);
    expect(owned.filter((resource) => resource.kind === "queue")).toEqual(
      [
        ["CRAWLS", CRAWLS],
        ["FAILED_CRAWLS", FAILED],
        ["JOBS", JOBS],
      ].map(([binding, name]) =>
        expect.objectContaining({ kind: "queue", binding, name, resourceId: account.queue(name!)!.id }),
      ),
    );
  });

  it("creates nothing on a redeploy, and keeps one consumer per queue", async () => {
    await deploy(CRAWL);
    const ids = [JOBS, CRAWLS, FAILED].map((name) => account.queue(name)!.id);
    await deploy(CRAWL);

    expect(queueCalls("create")).toHaveLength(3);
    expect([JOBS, CRAWLS, FAILED].map((name) => account.queue(name)!.id)).toEqual(ids);
    expect(consumersOf(JOBS)).toHaveLength(1);
    expect(consumersOf(CRAWLS)).toHaveLength(1);
    expect(appQueues()).toBe(3);
  });

  it("refuses a queue of its name that no deploy recorded, before anything is uploaded", async () => {
    account.createQueue(EMAILS);

    await expect(deploy(MAIL)).rejects.toMatchObject({
      code: "RESOURCE_NAME_TAKEN",
      message: expect.stringContaining(`A Queue named "${EMAILS}" already exists`),
    });
    expect(uploads("every-acme-mail")).toEqual([]);
    expect(queueCalls("create")).toEqual([]);
  });

  it("refuses a queue name Cloudflare would refuse, before anything is created", async () => {
    const long = `Q${"X".repeat(60)}`;
    await expect(deploy({ ...MAIL, resources: { d1: ["DB"], queues: [{ name: long }] } })).rejects.toMatchObject({
      code: "QUEUE_NAME_INVALID",
      message: expect.stringContaining(`${long} would be the queue "every-acme-mail--q`),
      fix: "shorten its binding name in everyapp.config.ts",
    });
    expect(queueCalls("create")).toEqual([]);
    expect([...account.databases.values()].map((db) => db.name)).not.toContain("every-acme-mail");
  });

  it("refuses a consumer helper workers doesn't declare", async () => {
    await expect(
      deploy({
        ...CRAWL,
        resources: { queues: [{ name: "JOBS", consumer: { worker: "ghost" } }] },
      }),
    ).rejects.toThrow('Queue JOBS is consumed by Worker "ghost", which workers doesn\'t declare.');
    expect(appQueues()).toBe(0);
    expect(account.deploys.filter((upload) => upload.workerName.startsWith(CRAWL_WORKER))).toEqual([]);
  });

  it("refuses a producer to, or a consumer of, a queue the deploy didn't provision", async () => {
    account.createQueue("every-acme-billing--jobs");
    account.editBuild = (config) => {
      config["env"].BILLING = { type: "queue", name: "every-acme-billing--jobs" };
    };
    await expect(deploy(MAIL)).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringContaining(
        'BILLING is queue "every-acme-billing--jobs", which isn\'t a queue the deploy provisioned',
      ),
    });

    account.editBuild = (config) => {
      config["triggers"] = [
        { type: "queue", name: "every-acme-billing--jobs" },
        { type: "queue", name: EMAILS, deadLetterQueue: "every-acme-mail--lost" },
      ];
    };
    await expect(deploy(MAIL)).rejects.toMatchObject({
      code: "APP_POLICY",
      message: expect.stringMatching(
        /it consumes queue "every-acme-billing--jobs", which isn't one of the app's queues[\s\S]*sends failed messages to "every-acme-mail--lost"/,
      ),
    });
    expect(uploads("every-acme-mail")).toEqual([]);
    expect(consumersOf("every-acme-billing--jobs")).toEqual([]);
    expect(account.queue("every-acme-mail--lost")).toBeUndefined();
  });

  it("says a consumer's Worker needs a queue() handler, with its version live", async () => {
    account.queueHandlerMissing.add(CRAWL_WORKER);

    await expect(deploy(CRAWL)).rejects.toMatchObject({
      code: "QUEUE_HANDLER_MISSING",
      message: expect.stringContaining(`${CRAWL_WORKER}'s new version is live without its queue consumers`),
      fix: expect.stringContaining("export async queue(batch, env)"),
    });
    const owned = await readOwnedResources(registry(), CRAWL_WORKER);
    expect(owned.find((resource) => resource.kind === "worker" && resource.binding === "")?.versionId).toBe(
      account.workers.get(CRAWL_WORKER)!.versions.at(-1),
    );

    // With the handler, the next deploy makes it the consumer.
    account.queueHandlerMissing.clear();
    await deploy(CRAWL);
    expect(consumersOf(JOBS)).toEqual([expect.objectContaining({ script: CRAWL_WORKER })]);
  });

  it("deletes the queues with the app on --purge: its Workers' consumers, then the Workers, then the queues", async () => {
    await deploy(CRAWL);
    const result = await purge("crawl");

    expect(appQueues()).toBe(0);
    expect(result.purged?.removed).toEqual(
      expect.arrayContaining([`Queue "${JOBS}"`, `Queue "${CRAWLS}"`, `Queue "${FAILED}"`]),
    );
    expect(result.purged?.kept).toEqual([]);
    const order = account.cf.calls.flatMap((call) => {
      const [kind, verb, third] = call.args;
      if (kind === "queues" && verb === "consumers" && third === "delete") return ["consumer"];
      if (kind === "workers" && verb === "delete") return [`worker ${third}`];
      if (kind === "queues" && verb === "delete") return ["queue"];
      return [];
    });
    expect(order).toEqual([
      "consumer",
      "consumer",
      `worker ${CRAWL_WORKER}`,
      `worker ${CRAWLER}`,
      "queue",
      "queue",
      "queue",
    ]);
    expect(queueCalls("delete").every((call) => call.args.includes("--force"))).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        step: "app.purge",
        status: "ok",
        data: expect.objectContaining({ kinds: expect.arrayContaining(["3 Queues"]) }),
      }),
    );
  });

  it("detaches a consumer added outside everyapp when Cloudflare refuses to delete the Worker, then deletes it", async () => {
    await deploy({ id: "plain", resources: { d1: ["DB"] } });
    const theirs = account.createQueue("customer-events");
    account.queues.get(theirs)!.consumers.set("consumer-by-hand", { script: "every-acme-plain", settings: {} });

    const result = await purge("plain");
    expect(account.workers.has("every-acme-plain")).toBe(false);
    expect(account.queues.get(theirs)!.consumers.size).toBe(0);
    expect(account.queue("customer-events")).toBeDefined();
    expect(result.purged?.removed).toContain('Worker "every-acme-plain"');
    expect(account.cf.calls.filter((call) => call.args[0] === "workers" && call.args[1] === "delete")).toHaveLength(2);
  });

  it("keeps a queue of the app's name that no deploy recorded, and says so", async () => {
    await deploy(MAIL);
    // The ledger no longer says the app made it.
    account
      .database("every-app-gateway")
      .all("DELETE FROM _everyapp_app_resources WHERE kind = 'queue'");

    const result = await purge("mail");
    expect(account.queue(EMAILS)).toBeDefined();
    expect(result.purged?.kept).toEqual([`Queue "${EMAILS}"`]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "warning", code: "RESOURCES_KEPT", message: expect.stringContaining(EMAILS) }),
    );
  });
});
