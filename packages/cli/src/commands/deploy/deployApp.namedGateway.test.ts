/**
 * `everyapp deploy` to a named Gateway (`setup --name demo`) in an account
 * that also holds the default one: the app takes the named Gateway's
 * names (perimeter manifest/gatewayNames.ts), binds its Worker, and the
 * default Gateway is never touched. The same fake account as
 * deployApp.test.ts: real SQLite D1, Build Outputs validated with cf's
 * schema, the app's Worker built by the SDK's real everyAppWorker().
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gatewayNames } from "@every-app/perimeter/manifest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const DEMO = gatewayNames("demo");

const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: { d1: ["DB"] },
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

/** Install a Gateway of these names at `host` (apps one label below it). */
async function installGateway(names: typeof DEMO | undefined, host: string): Promise<void> {
  const resources = await ensureGatewayResources(account.cf, names);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release,
    accountId: ACCOUNT_ID,
    gatewayHost: host,
    zone: { id: "zone-1", name: "example.com" },
    appBaseDomain: host,
    resources,
    db: cfD1Database(account.cf, resources.d1Id),
    interactive: false,
    cliVersion: "0.3.0",
    ...(names ? { names } : {}),
    ...seams,
  });
}

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  vi.stubEnv("EVERYAPP_GATEWAY_URL", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account, DEMO.worker);

  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  // The default Gateway at the apex, and Gateway demo beside it.
  await installGateway(undefined, "example.com");
  await installGateway(DEMO, "demo.example.com");

  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "drizzle", "0000_init.sql"), "CREATE TABLE todos (id text PRIMARY KEY);");
  fs.writeFileSync(
    path.join(appDir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  account.apps.set(appDir, TODO);
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("deploy to a named Gateway", () => {
  it("names the app after Gateway demo, binds it there, and leaves the default Gateway alone", async () => {
    const defaultVersions = account.workers.get("every-app-gateway")!.versions.length;
    account.pushedMessages.length = 0;

    const result = await deployApp({
      cwd: appDir,
      manifest: TODO,
      gateway: "demo",
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
      reconcile: {
        ...seams,
        openRelease: () => openRelease(tarball),
        source: () => releaseSource(tarball),
      },
      live: { fetch: worker.fetch, sleep: async () => undefined },
    });

    // The app's Worker and its D1 under the named Gateway's prefix.
    const workerName = "every-demo--acme-todo";
    expect(result).toMatchObject({ workerName, liveUrl: "https://todo.demo.example.com" });
    expect(account.database(workerName).all("SELECT name FROM d1_migrations")).toEqual([{ name: "0000_init.sql" }]);

    // Its GATEWAY service binding names Gateway demo's Worker.
    const upload = account.deploys.find((d) => d.workerName === workerName)!;
    expect(upload.config["env"]).toMatchObject({
      DB: { type: "d1", name: workerName },
      EVERY_APP_GATEWAY: { type: "worker", worker: DEMO.worker, exportName: "AppGateway" },
    });

    // Gateway demo was uploaded with the app bound, and knows its name.
    const gatewayUpload = account.deploys.filter((d) => d.workerName === DEMO.worker).at(-1)!;
    expect(gatewayUpload.config["env"]["EVERYAPP_GATEWAY_NAME"]).toEqual({ type: "text", value: "demo" });
    expect(account.gatewayBindings(DEMO.worker)).toEqual([workerName]);

    // Its activation queue was nudged, not the default's.
    expect(account.pushedMessages.map((message) => message.queue)).toEqual(["every-app-gateway-demo-activate"]);

    // The default Gateway: no new version, nothing bound, no row.
    expect(account.workers.get("every-app-gateway")!.versions).toHaveLength(defaultVersions);
    expect(account.gatewayBindings()).toEqual([]);
    expect(account.database("every-app-gateway").all("SELECT id FROM apps")).toEqual([]);
  });
});
