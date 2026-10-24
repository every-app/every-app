/**
 * What `everyapp deploy` says about an app's settings, end to end in the
 * fake Cloudflare account (test/fakeCloudflare.ts): after the upload the
 * Worker's own secret names go on the app's row (`secret_names`), and an
 * app whose required settings aren't all set ends with an APP_NEEDS_SETUP
 * warning and the one `configure` that opens it under Next. A ready app,
 * or one that declares nothing to set, gets neither.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { readApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const WORKER = "every-acme-crm";

/** An AI provider, an optional capability, and a required secret with its why. */
const CRM: EveryAppCliManifest = {
  id: "crm",
  resources: { d1: ["DB"] },
  providers: [{ id: "openrouter", why: "Drafts replies." }],
  capabilities: { context: { access: "read", optional: true } },
  secrets: [{ name: "TOKEN_ENCRYPTION_KEY", why: "Encrypts the OAuth tokens it stores." }],
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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-crm-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "drizzle", "0000_init.sql"), "CREATE TABLE contacts (id text PRIMARY KEY);");
  fs.writeFileSync(
    path.join(appDir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function deploy(manifest: EveryAppCliManifest = CRM) {
  account.apps.set(appDir, manifest);
  events = [];
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
    interactive: false,
  });
}

const registry = () =>
  cfD1Database(
    account.cf,
    [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0],
  );
/** The run's APP_NEEDS_SETUP warnings (the domain and schema checks warn about other things). */
const warnings = () =>
  events.filter((event) => event["type"] === "warning" && event["code"] === "APP_NEEDS_SETUP");
const gateway = () => account.workers.get("every-app-gateway")!;
/** The `workers secrets list` calls made of a Worker since call number `since`. */
const secretLists = (since: number, workerName: string) =>
  account.cf.calls
    .slice(since)
    .filter((call) => call.args.slice(0, 3).join(" ") === "workers secrets list" && call.args.includes(workerName));

describe("deploy and the app's settings", () => {
  it("records the Worker's secret names, and ends with what to set when the app needs setup", async () => {
    const result = await deploy();

    // Nothing set yet: the names are recorded as none, and the app won't open.
    expect((await readApp(registry(), "crm")).secretNames).toEqual([]);
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "APP_NEEDS_SETUP",
        step: "app.secrets",
        message: "crm won't open until OPENROUTER_API_KEY and TOKEN_ENCRYPTION_KEY are set\nOpenRouter: Drafts replies.",
        data: {
          setup: expect.objectContaining({
            ready: false,
            unmet: [
              expect.objectContaining({ id: "openrouter" }),
              expect.objectContaining({ id: "TOKEN_ENCRYPTION_KEY" }),
            ],
          }),
        },
      }),
    ]);
    expect(result.next).toEqual([
      { command: "pnpm everyapp configure crm", note: "asks for each; crm opens once they are set" },
    ]);

    // Set by hand (as `secret set` would), the redeploy records them and says nothing.
    gateway().secrets["OPENROUTER_API_KEY"] = "sk-or";
    account.workers.get(WORKER)!.secrets["TOKEN_ENCRYPTION_KEY"] = "tek";
    const again = await deploy();
    expect((await readApp(registry(), "crm")).secretNames).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    expect(warnings()).toEqual([]);
    expect(again.next).toEqual([]);
  });

  it("says nothing about settings for an app that declares none, or whose only unset ones are optional", async () => {
    const before = account.cf.calls.length;
    await deploy({ id: "crm", resources: { d1: ["DB"] } });
    expect(warnings()).toEqual([]);
    expect(events.filter((event) => event["step"] === "app.secrets")).toEqual([]);
    // Nothing to evaluate: the Gateway's secrets aren't listed either.
    expect(secretLists(before, "every-app-gateway")).toEqual([]);

    gateway().secrets["OPENROUTER_API_KEY"] = "sk-or";
    account.workers.get(WORKER)!.secrets["TOKEN_ENCRYPTION_KEY"] = "tek";
    const result = await deploy({ ...CRM, capabilities: { context: { access: "read", optional: true } } });
    expect(warnings()).toEqual([]);
    expect(result.next).toEqual([]);
  });

  it("still warns about the app's own unset secret when the Gateway's names can't be listed", async () => {
    account.cf.override(
      (args) => args.slice(0, 3).join(" ") === "workers secrets list" && args.includes("every-app-gateway"),
      { exitCode: 1, stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n" },
    );

    const result = await deploy();

    expect(result.live).toBe(true);
    expect((await readApp(registry(), "crm")).secretNames).toEqual([]);
    // The Gateway's settings read as unknown, which never blocks; the app's own is known unset.
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "APP_NEEDS_SETUP",
        message: "crm won't open until TOKEN_ENCRYPTION_KEY is set\nTOKEN_ENCRYPTION_KEY: Encrypts the OAuth tokens it stores.",
        data: {
          setup: expect.objectContaining({
            unmet: [expect.objectContaining({ id: "TOKEN_ENCRYPTION_KEY", set: false })],
            settings: expect.arrayContaining([expect.objectContaining({ id: "openrouter", set: null })]),
          }),
        },
      }),
    ]);
    expect(result.next).toEqual([
      { command: "pnpm everyapp configure crm", note: "asks for each; crm opens once they are set" },
    ]);
  });

  it("keeps the upload, unrecorded, when cf can't list the Worker's secrets", async () => {
    account.cf.override(
      (args) => args.slice(0, 3).join(" ") === "workers secrets list" && args.includes(WORKER),
      { exitCode: 1, stderr: "┌ Error\n│ Authentication error [code: 10000]\n└\n" },
    );

    const result = await deploy();

    expect(result.live).toBe(true);
    expect((await readApp(registry(), "crm")).secretNames).toBeNull();
    // The Gateway's names still read: its unset key is said; the app's own, unknown, isn't.
    expect(warnings()).toEqual([
      expect.objectContaining({
        code: "APP_NEEDS_SETUP",
        message: expect.stringMatching(/^crm won't open until OPENROUTER_API_KEY is set\n/),
      }),
    ]);
  });
});
