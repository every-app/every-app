/**
 * App releases end to end: `everyapp release` packs the app the fake
 * Cloudflare builds (the SDK's real everyAppWorker(), tenant-neutral), and
 * `everyapp install <tarball | github url>` installs the release into a
 * Gateway this CLI deployed, with no checkout of the app. The hosted gateway's own reader of a release
 * (apps/every-app-gateway/src/server/deploy/{tar,release}.ts) reads what
 * the packer writes.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_SENTINEL } from "@every-app/sdk/cloudflare";
import {
  describeAppOrigin,
  fetchAppRelease,
  openAppRelease,
  packAppRelease,
  type AppRelease,
} from "@/lib/app/release";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createNdjsonSink } from "@/lib/output/events";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "../deploy/deployApp";
import { bundleApp } from "../release/bundleApp";

// The hosted gateway's release reader, loaded by path: it is another package.
const GATEWAY_DEPLOY = "../../../../../apps/every-app-gateway/src/server/deploy";
interface GatewayReader {
  readTar(archive: Uint8Array, limits: { maxFiles: number }): Map<string, Uint8Array>;
}
interface GatewayRelease_ {
  bundleFromRelease(files: ReadonlyMap<string, Uint8Array>): Promise<{
    release: { appId: string; version: string };
    bundle: {
      worker: Record<string, any>;
      modules: Map<string, Uint8Array>;
      migrations: Array<{ name: string; sql: string }>;
      manifest: Record<string, unknown>;
    };
  }>;
}

const TODO: EveryAppCliManifest = {
  id: "todo",
  name: "Todos",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
    durableObjects: [{ name: "USER_SYNC", className: "UserSyncDO" }],
  },
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let gatewayTarball: string;
let gatewayRelease: GatewayRelease;
let appDir: string;
let elsewhere: string;
let home: string;
let events: Array<Record<string, any>>;
const opened: AppRelease[] = [];

const out = () => createNdjsonSink((line) => events.push(JSON.parse(line)));
const seams = { sleep: async () => undefined, leaseWaitMs: 0 };
const rebind = {
  ...seams,
  openRelease: () => openRelease(gatewayTarball),
  source: () => releaseSource(gatewayTarball),
};
const live = () => ({ fetch: worker.fetch, sleep: async () => undefined });

beforeEach(async () => {
  events = [];
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  gatewayTarball = await buildGatewayRelease();
  gatewayRelease = await openRelease(gatewayTarball);
  const resources = await ensureGatewayResources(account.cf);
  await applyGateway({
    cf: account.cf,
    out: out(),
    reason: "deploy",
    release: gatewayRelease,
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

  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "todo", version: "1.4.0" }));
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY, title text);",
  );
  fs.writeFileSync(
    path.join(appDir, "drizzle", "meta", "_journal.json"),
    JSON.stringify({ entries: [{ tag: "0000_init", when: 1000 }] }),
  );
  // Where a person deploys a release from: no app there.
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-elsewhere-"));
  events = [];
});

afterEach(async () => {
  for (const release of opened.splice(0)) await release.cleanup();
  await gatewayRelease.cleanup();
  vi.unstubAllEnvs();
  for (const dir of [home, appDir, elsewhere]) fs.rmSync(dir, { recursive: true, force: true });
});

/** `everyapp release` in the app's directory. */
function bundle(manifest: EveryAppCliManifest = TODO) {
  account.apps.set(appDir, manifest);
  return bundleApp({
    cwd: appDir,
    manifest,
    outFile: "everyapp-release.tar.gz",
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
  });
}

async function open(tarball: string, options?: Parameters<typeof openAppRelease>[1]) {
  const release = await openAppRelease(tarball, options);
  opened.push(release);
  return release;
}

/** `everyapp install <source>` from a directory with no app in it. */
function installRelease(release: AppRelease) {
  return deployApp({
    cwd: elsewhere,
    release,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => {
      throw new Error("a release installs no dependencies");
    },
    reconcile: rebind,
    live: live(),
  });
}

const builds = () => account.cf.calls.filter((call) => call.args[0] === "build").length;
const upload = (index = -1) =>
  account.deploys.filter((d) => d.workerName === "every-acme-todo").at(index)!;

describe("everyapp release", () => {
  it("packs a release of the app's tenant-neutral build that the CLI and the hosted gateway both read", async () => {
    const result = await bundle();
    const tarball = path.join(appDir, "everyapp-release.tar.gz");
    expect(result).toMatchObject({ tarball, version: "1.4.0", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // Only a release's own entries, without macOS's ._ files.
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(new Set(listing.map((entry) => entry.replace(/^\.\//, "").split("/")[0]).filter(Boolean))).toEqual(
      new Set([".cloudflare", "migrations", "release.json"]),
    );
    expect(listing.some((entry) => path.basename(entry).startsWith("._"))).toBe(false);

    const release = await open(tarball);
    expect(release.release).toMatchObject({
      schema: 1,
      kind: "app",
      appId: "todo",
      version: "1.4.0",
      gitSha: "unknown",
      buildOutputVersion: "v0",
      sha256: result.sha256,
      migrations: [{ tag: "0000_init", when: 1000 }],
      minCli: "0.3.0",
      cliVersion: expect.any(String),
    });
    // Its migrations are the release's migrations/.
    expect(release.manifest).toEqual({ ...TODO, migrations: { engine: "drizzle", dir: "migrations" } });
    expect(fs.readFileSync(path.join(release.dir, "migrations/0000_init.sql"), "utf8")).toContain("CREATE TABLE todos");
    const config = JSON.parse(
      fs.readFileSync(path.join(release.dir, ".cloudflare/output/v0/workers/default/worker.config.json"), "utf8"),
    );
    expect(config.name).toBe(BUILD_SENTINEL.workerName);
    expect(config.env.EVERYAPP_IDENTITY_ISSUER.value).toBe(BUILD_SENTINEL.gatewayUrl);
    expect(events.find((event) => event["step"] === "app.release")?.["message"]).toContain(
      `Packed todo 1.4.0 (${result.sha256.slice(0, 12)})`,
    );

    // The hosted gateway's reader agrees on every file and the hash.
    const { readTar } = (await import(/* @vite-ignore */ `${GATEWAY_DEPLOY}/tar.ts`)) as GatewayReader;
    const { bundleFromRelease } = (await import(/* @vite-ignore */ `${GATEWAY_DEPLOY}/release.ts`)) as GatewayRelease_;
    const files = readTar(gunzipSync(fs.readFileSync(tarball)), { maxFiles: 10_000 });
    const read = await bundleFromRelease(files);
    expect(read.release).toMatchObject({ appId: "todo", version: "1.4.0" });
    expect(read.bundle.worker["name"]).toBe(BUILD_SENTINEL.workerName);
    expect(read.bundle.migrations.map((migration) => migration.name)).toEqual(["0000_init.sql"]);
    expect([...read.bundle.modules.keys()]).toContain("index.js");
  });

  it("carries the provider specs the app bundles in release.json, and refuses one that isn't JSON", async () => {
    await bundle();
    const specsDir = path.join(appDir, ".everyapp", "providers");
    fs.mkdirSync(specsDir, { recursive: true });
    const northwind = {
      id: "northwind",
      name: "Northwind",
      docs: "https://developer.northwind.io/keys",
      hosts: ["api.northwind.io"],
      auth: { kind: "bearer", secret: "NORTHWIND_API_KEY" },
    };
    fs.writeFileSync(path.join(specsDir, "northwind.json"), JSON.stringify(northwind));
    const outFile = path.join(appDir, "with-providers.tar.gz");
    const packed = await packAppRelease({ cwd: appDir, manifest: TODO, outFile, cfVersion: "1.0.0" });
    expect(packed.providers).toEqual([northwind]);
    const opened = await openAppRelease(outFile);
    try {
      expect(opened.release.providers).toEqual([northwind]);
      // `.everyapp/` itself never ships: the specs ride in release.json alone.
      expect(fs.existsSync(path.join(opened.dir, ".everyapp"))).toBe(false);
    } finally {
      await opened.cleanup();
    }
    fs.writeFileSync(path.join(specsDir, "broken.json"), "{ not json");
    await expect(packAppRelease({ cwd: appDir, manifest: TODO, outFile, cfVersion: "1.0.0" })).rejects.toMatchObject({
      code: "RELEASE_PACK_FAILED",
      message: expect.stringContaining("broken.json isn't JSON"),
    });
    fs.rmSync(specsDir, { recursive: true });
  });

  it("refuses local state, a build that isn't production's, and Prisma migrations", async () => {
    await bundle();
    const outFile = path.join(appDir, "again.tar.gz");
    const pack = (manifest: EveryAppCliManifest = TODO) =>
      packAppRelease({ cwd: appDir, manifest, outFile, cfVersion: "1.0.0" });

    const devVars = path.join(appDir, ".cloudflare/output/v0/workers/default/assets/.dev.vars");
    fs.mkdirSync(path.dirname(devVars), { recursive: true });
    fs.writeFileSync(devVars, "SECRET=1");
    await expect(pack()).rejects.toMatchObject({
      code: "RELEASE_LOCAL_STATE",
      message: expect.stringContaining("assets/.dev.vars"),
    });
    fs.rmSync(devVars);

    fs.writeFileSync(
      path.join(appDir, ".cloudflare/output/v0/config.json"),
      JSON.stringify({ buildContext: { isPreview: false, mode: "development" } }),
    );
    await expect(pack()).rejects.toMatchObject({
      code: "RELEASE_PACK_FAILED",
      message: expect.stringContaining("isn't a production build"),
    });
    fs.writeFileSync(
      path.join(appDir, ".cloudflare/output/v0/config.json"),
      JSON.stringify({ buildContext: { isPreview: false, mode: "production" } }),
    );

    await expect(
      pack({
        id: "todo",
        database: { provider: "postgres" },
        migrations: { engine: "prisma", dialect: "postgresql" },
      } as EveryAppCliManifest),
    ).rejects.toMatchObject({ code: "RELEASE_MIGRATIONS_UNSUPPORTED" });
    expect(fs.existsSync(outFile)).toBe(false);
  });
});

describe("everyapp install <release>", () => {
  it("installs a release with no checkout of the app, uploading what a deploy from its directory uploads", async () => {
    const { tarball } = await bundle();
    const release = await open(tarball);
    const before = builds();
    events = [];

    const result = await installRelease(release);

    expect(result).toMatchObject({ liveUrl: "https://todo.example.com", workerName: "every-acme-todo", live: true });
    // Nothing built or installed; the release's migrations applied.
    expect(builds()).toBe(before);
    expect(account.database("every-acme-todo").all("SELECT name FROM d1_migrations")).toEqual([
      { name: "0000_init.sql" },
    ]);
    expect(events.find((event) => event["step"] === "app.deploy")).toMatchObject({
      type: "step",
      data: { appId: "todo", version: "1.4.0", origin: tarball, firstDeploy: true },
    });
    // Nothing was built: the release was checked.
    expect(events.find((event) => event["step"] === "app.build")).toMatchObject({
      status: "ok",
      data: { release: true },
    });
    expect(
      events.find((event) => event["step"] === "app.schema" && event["type"] === "progress")?.["message"],
    ).toContain("publisher checked its migrations");
    const fromRelease = upload().config;
    expect(JSON.stringify(fromRelease)).not.toContain("sentinel");
    expect(fromRelease["name"]).toBe("every-acme-todo");
    // Its first recorded upload is the app's install, from a release.
    const queued = () =>
      account
        .database("every-app-gateway")
        .all("SELECT type, data FROM events ORDER BY rowid")
        .map((row) => ({ type: row["type"], data: JSON.parse(String(row["data"])) }));
    expect(queued()).toEqual([
      { type: "app.installed", data: expect.objectContaining({ app: expect.objectContaining({ id: "todo" }), source: "release" }) },
    ]);

    // The same app deployed from its directory uploads the same Worker.
    account.apps.set(appDir, TODO);
    await deployApp({
      cwd: appDir,
      manifest: TODO,
      out: out(),
      createCf: () => account.cf,
      installDeps: async () => undefined,
      reconcile: rebind,
      live: live(),
    });
    expect(upload().config).toEqual(fromRelease);
    expect(queued().map((event) => event.type)).toEqual(["app.installed", "app.updated"]);
  });

  it("takes a GitHub repository's latest release, and sends a repository without one to its clone", async () => {
    const { tarball } = await bundle();
    const github = fakeGithubReleases({
      "acme/todo": [{ tag: "v1.4.0", assets: { "everyapp-release.tar.gz": tarball } }],
    });

    const release = await fetchAppRelease("https://github.com/acme/todo", { out: out(), fetch: github.fetch });
    opened.push(release);
    expect(release.origin).toEqual({ kind: "github", repo: "acme/todo", tag: "v1.4.0" });
    expect(describeAppOrigin(release.origin)).toBe("github.com/acme/todo (release v1.4.0)");
    // Redirected to the tag's asset, then to the asset host; anonymously.
    expect(github.requests.map((request) => new URL(request.url).hostname)).toEqual([
      "github.com",
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
    expect(github.requests.every((request) => request.init?.credentials === "omit")).toBe(true);

    events = [];
    await installRelease(release);
    expect(events.find((event) => event["step"] === "app.deploy")?.["data"]).toMatchObject({
      version: "1.4.0",
      origin: "github.com/acme/todo (release v1.4.0)",
    });

    await expect(
      fetchAppRelease("https://github.com/acme/notes", { out: out(), fetch: github.fetch }),
    ).rejects.toMatchObject({
      code: "NO_RELEASE",
      message:
        "acme/notes publishes no everyapp release\nIts GitHub releases have no everyapp-release.tar.gz.",
      fix: "clone it, then run pnpm install in it and this checkout's pnpm everyapp deploy from its directory",
    });
  });

  it("refuses a release that needs a newer everyapp, or a Gateway's", async () => {
    const { tarball } = await bundle();
    await expect(open(tarball, { version: "0.2.0" })).rejects.toMatchObject({
      code: "CLI_TOO_OLD",
      message: expect.stringContaining("todo 1.4.0 needs everyapp 0.3.0 or newer (this is 0.2.0)"),
    });
    await expect(openAppRelease(gatewayTarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringContaining("is a gateway release, not an app release"),
    });
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringContaining("is an app release, not a Gateway release"),
    });
  });

  it("refuses a release whose database is Postgres before registering it", async () => {
    const { tarball } = await bundle();
    const release = await open(tarball);
    await expect(
      installRelease({
        ...release,
        manifest: {
          ...release.manifest,
          database: { provider: "postgres" },
          migrations: { engine: "drizzle", dialect: "postgresql", dir: "migrations" },
        } as EveryAppCliManifest,
      }),
    ).rejects.toMatchObject({
      code: "RELEASE_MIGRATIONS_UNSUPPORTED",
      message: "todo can't deploy from a release: its Postgres migrations need the source",
    });
    expect(account.database("every-app-gateway").all("SELECT id FROM apps")).toEqual([]);
  });
});
