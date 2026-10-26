/**
 * The provider specs an app bundles (`.everyapp/providers/<id>.json`),
 * registered by `everyapp deploy` after one confirmation, end to end in the
 * fake Cloudflare account: refused under --json without --yes before
 * anything is registered, registered with --yes and then offered to the
 * manifest, left alone when the row has the same spec, refused when the
 * row has another spec, warned about for a catalog id, and refused when
 * the file isn't a spec.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { addProvider, gatewayRegistry } from "@/lib/gateway/providers";
import { findRegisteredApp } from "@/lib/gateway/registry";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const NORTHWIND = {
  id: "northwind",
  name: "Northwind",
  docs: "https://developer.northwind.io/keys",
  hosts: ["api.northwind.io"],
  auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
};
const SHOP: EveryAppCliManifest = {
  id: "shop",
  resources: { d1: ["DB"] },
  capabilities: { northwind: { access: "read", why: "Shows the last charges." } },
};
const INSTALL = { gatewayHost: "example.com", appBaseDomain: "example.com" };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let events: Array<Record<string, any>>;

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-shop-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "drizzle", "0000_init.sql"), "CREATE TABLE orders (id text PRIMARY KEY);");
  fs.writeFileSync(path.join(appDir, "drizzle", "meta", "_journal.json"), JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }));
  events = [];
});

afterEach(async () => {
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

function bundle(name: string, spec: unknown) {
  const dir = path.join(appDir, ".everyapp", "providers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof spec === "string" ? spec : JSON.stringify(spec));
}

function deploy(options: { yes?: boolean; json?: boolean; confirm?: (q: string) => Promise<boolean>; manifest?: EveryAppCliManifest } = {}) {
  const manifest = options.manifest ?? SHOP;
  account.apps.set(appDir, manifest);
  events = [];
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    json: options.json ?? true,
    yes: options.yes,
    confirm: options.confirm,
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
    live: { fetch: worker.fetch, sleep: async () => undefined },
    interactive: options.confirm !== undefined,
  });
}

const registry = () =>
  cfD1Database(account.cf, [...account.databases].find(([, db]) => db.name === "every-app-gateway")![0]);
const rows = async () => (await gatewayRegistry(registry(), INSTALL)).rows().map((row) => row.id);
const steps = (step: string) => events.filter((event) => event["type"] === "step" && event["step"] === step);
const warnings = () => events.filter((event) => event["type"] === "warning");

describe("the providers an app bundles", () => {
  it("lists them and stops with CONFIRMATION_REQUIRED under --json without --yes, registering nothing", async () => {
    bundle("northwind.json", NORTHWIND);
    await expect(deploy()).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
      authorize: true,
      message: expect.stringContaining("shop bundles northwind to register on example.com"),
      data: { providers: [expect.objectContaining({ id: "northwind", hosts: ["api.northwind.io"], settings: ["NORTHWIND_API_KEY"], outcome: "registered" })] },
    });
    expect(steps("app.providers")[0]?.["message"]).toContain("Northwind (northwind): its key goes to api.northwind.io; settings NORTHWIND_API_KEY");
    expect(await rows()).toEqual([]);
    expect(await findRegisteredApp(registry(), "shop")).toBeNull();
  });

  it("registers them with --yes (or a yes at the terminal), then deploys the app that lists them", async () => {
    bundle("northwind.json", NORTHWIND);
    const result = await deploy({ yes: true });
    expect(result.live).toBe(true);
    expect(await rows()).toEqual(["northwind"]);
    expect(steps("app.providers").at(-1)?.["message"]).toBe("Registered Northwind (northwind) on example.com.");
    // The app needs the key next: the setup warning names it.
    expect(warnings().map((w) => w["code"])).toContain("APP_NEEDS_SETUP");

    // Deployed again, the row has the same spec: nothing to ask, nothing written twice.
    const again = await deploy();
    expect(again.live).toBe(true);
    expect(steps("app.providers").map((s) => s["message"])).toEqual([
      "northwind is registered on example.com already, as shop bundles it.",
    ]);

    // A person at a terminal is asked once, and No stops before anything.
    fs.rmSync(path.join(appDir, ".everyapp"), { recursive: true });
    bundle("contoso.json", { ...NORTHWIND, id: "contoso", name: "Contoso", hosts: ["api.contoso.dev"], auth: { kind: "bearer", secret: "CONTOSO_API_KEY" } });
    const asked: string[] = [];
    await expect(deploy({ json: false, confirm: async (q) => (asked.push(q), false) })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(asked).toEqual(["Register contoso on example.com?"]);
    expect(await rows()).toEqual(["northwind"]);
  });

  it("never overwrites a row with another spec, and says what to do", async () => {
    await addProvider(registry(), { spec: { ...NORTHWIND, hosts: ["api.northwind.dev"] }, deployer: { actor: "ops@example.com", email: "ops@example.com" }, install: INSTALL });
    bundle("northwind.json", NORTHWIND);
    await expect(deploy({ yes: true })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_DIFFERS",
      message: expect.stringContaining("northwind is registered on example.com with another spec than shop bundles (.everyapp/providers/northwind.json)"),
      fix: expect.stringContaining("pnpm everyapp provider add .everyapp/providers/northwind.json --replace"),
      data: { id: "northwind", file: ".everyapp/providers/northwind.json", registeredBy: "ops@example.com" },
    });
    expect(await findRegisteredApp(registry(), "shop")).toBeNull();
  });

  it("warns about a catalog id and ignores the file; refuses a file that isn't a spec before anything", async () => {
    bundle("dataforseo.json", { ...NORTHWIND, id: "dataforseo", name: "DataForSEO" });
    const result = await deploy({ yes: true, manifest: { id: "shop", resources: { d1: ["DB"] } } });
    expect(result.live).toBe(true);
    expect(warnings().find((w) => w["code"] === "PROVIDER_BUNDLED_BUILTIN")).toMatchObject({
      message: expect.stringContaining("dataforseo.json describes dataforseo, which is built in"),
      data: { id: "dataforseo", file: ".everyapp/providers/dataforseo.json" },
    });
    expect(await rows()).toEqual([]);

    bundle("broken.json", "{ not json");
    await expect(deploy({ yes: true })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringContaining("shop bundles a provider spec this Gateway doesn't take: .everyapp/providers/broken.json\nit isn't JSON"),
    });
    fs.writeFileSync(path.join(appDir, ".everyapp/providers/broken.json"), JSON.stringify({ ...NORTHWIND, id: "bad", auth: { kind: "nope" } }));
    await expect(deploy({ yes: true })).rejects.toMatchObject({
      code: "PROVIDER_SPEC_INVALID",
      message: expect.stringMatching(/broken\.json\n.*auth\.kind: must be bearer/),
    });
    expect(await rows()).toEqual([]);
  });
});
