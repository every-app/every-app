/**
 * Renaming an app with `previousIds` (docs/design/2026-11-app-rename.md),
 * end to end against the fake Cloudflare account: the deploy moves the
 * registered app to its new id and hostname, keeps its Worker and
 * resources, keeps publishing the old hostname, and moves page loads there
 * once the new one answers; what isn't a rename of one app is refused
 * before anything changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const TALK: EveryAppCliManifest = {
  id: "talk",
  name: "Talk",
  resources: { d1: ["DB"], kv: ["KV"] },
};
const SCRIBE: EveryAppCliManifest = { ...TALK, id: "scribe", name: "Scribe", previousIds: ["talk"] };

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
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-app-"));
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "export default defineConfig((ctx) => ({ worker: everyAppWorker({ manifest, entrypoint, ctx }) }));\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle", "meta"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "drizzle", "0000_init.sql"), "CREATE TABLE notes (id text PRIMARY KEY);");
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

function deploy(manifest: EveryAppCliManifest, options: Partial<Parameters<typeof deployApp>[0]> = {}) {
  account.apps.set(appDir, manifest);
  return deployApp({
    cwd: appDir,
    manifest,
    out: out(),
    createCf: () => account.cf,
    installDeps: async () => undefined,
    reconcile: rebind,
    live: { fetch: worker.fetch, sleep: async () => undefined },
    ...options,
  });
}

const gateway = () => account.database("every-app-gateway");
const appRows = () => gateway().all("SELECT id, app_slug, hostname, worker_name, status FROM apps ORDER BY app_slug");
const previousIds = () =>
  gateway().all("SELECT app_slug, app_row_id, hostname, moved_at, retired_at FROM app_previous_ids ORDER BY app_slug");
const errorOf = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as { code?: string; message: string; rerun?: string; authorize?: boolean };
  }
  throw new Error("expected the deploy to fail");
};

describe("deploy with previousIds", () => {
  it("renames the app: new id and hostname, same row, Worker and data; the old host kept and moved", async () => {
    await deploy(TALK);
    const [talk] = appRows();
    const grantee = "user-x";
    // Gateway state keyed by the app's row: a person's grant.
    gateway().sqlite.prepare("INSERT INTO users (id, name, email) VALUES (?, 'X', 'x@example.com')").run(grantee);
    gateway()
      .sqlite.prepare(
        "INSERT INTO user_app_access (id, user_id, app_row_id, organization_id) VALUES ('grant-1', ?, ?, ?)",
      )
      .run(grantee, String(talk!["id"]), String(gateway().all("SELECT organization_id FROM apps")[0]!["organization_id"]));
    const databases = account.databases.size;
    events = [];

    const result = await deploy(SCRIBE, { yes: true });

    expect(result).toMatchObject({
      liveUrl: "https://scribe.example.com",
      hostname: "scribe.example.com",
      workerName: "every-acme-talk",
    });
    expect(appRows()).toEqual([
      { id: talk!["id"], app_slug: "scribe", hostname: "scribe.example.com", worker_name: "every-acme-talk", status: "active" },
    ]);
    // No new database: the app's own, under its Worker's name, is the one bound.
    expect(account.databases.size).toBe(databases);
    const upload = account.deploys.filter((d) => d.workerName === "every-acme-talk").at(-1)!;
    expect(upload.config["env"]).toMatchObject({
      DB: { type: "d1", name: "every-acme-talk" },
      EVERYAPP_AUDIENCE: { type: "text", value: "every-acme-talk" },
      EVERY_APP_GATEWAY: { props: { appId: "scribe", workerName: "every-acme-talk" } },
    });
    // The grant followed the row.
    expect(gateway().all("SELECT app_row_id FROM user_app_access")).toEqual([{ app_row_id: talk!["id"] }]);
    // Both hostnames are the gateway's, and the old one redirects page loads now.
    expect(account.customDomains.get("scribe.example.com")).toBe("every-app-gateway");
    expect(account.customDomains.get("talk.example.com")).toBe("every-app-gateway");
    expect(previousIds()).toEqual([
      expect.objectContaining({ app_slug: "talk", app_row_id: talk!["id"], hostname: "talk.example.com", retired_at: null }),
    ]);
    expect(previousIds()[0]!["moved_at"]).not.toBeNull();

    const rename = events.filter((event) => event["step"] === "app.rename");
    expect(rename[0]).toMatchObject({
      status: "start",
      data: { from: "talk", to: "scribe", fromHostname: "talk.example.com", hostname: "scribe.example.com" },
    });
    expect(rename[0]!["message"]).toContain("every-acme-talk");
    expect(rename.at(-1)).toMatchObject({ status: "ok", data: { previousHostnames: ["talk.example.com"] } });

    // A redeploy is a plain one.
    events = [];
    await deploy(SCRIBE);
    expect(events.some((event) => event["step"] === "app.rename")).toBe(false);
  });

  it("asks first: unattended without --yes it stops before anything changes, and No cancels", async () => {
    await deploy(TALK);
    const before = appRows();

    const unattended = await errorOf(deploy(SCRIBE));
    expect(unattended).toMatchObject({ code: "CONFIRMATION_REQUIRED", authorize: true });
    expect(unattended.rerun).toContain("--yes");
    expect(appRows()).toEqual(before);
    expect(previousIds()).toEqual([]);

    const confirm = vi.fn(async () => false);
    await expect(deploy(SCRIBE, { interactive: true, confirm })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(confirm).toHaveBeenCalledWith(
      "Rename talk to scribe?",
      expect.arrayContaining([expect.stringContaining("Old host"), expect.stringContaining("every-acme-talk")]),
    );
    expect(appRows()).toEqual(before);
  });

  it("keeps serving the old host in full until the new one answers", async () => {
    await deploy(TALK);
    worker.certificatePending.add("scribe.example.com");
    events = [];

    await deploy(SCRIBE, { yes: true, live: { fetch: worker.fetch, sleep: async () => undefined, maxWaitMs: 0 } });

    expect(previousIds()[0]).toMatchObject({ moved_at: null, retired_at: null });
    expect(events.find((event) => event["code"] === "RENAME_NOT_MOVED")).toBeTruthy();

    worker.certificatePending.delete("scribe.example.com");
    await deploy(SCRIBE);
    expect(previousIds()[0]!["moved_at"]).not.toBeNull();
  });

  it("retires the old hostname once previousIds drops it, and keeps the id the app's", async () => {
    await deploy(TALK);
    await deploy(SCRIBE, { yes: true });
    events = [];

    await deploy({ ...SCRIBE, previousIds: undefined });

    expect(previousIds()[0]!["retired_at"]).not.toBeNull();
    expect(account.customDomains.has("talk.example.com")).toBe(false);
    expect(account.customDomains.get("scribe.example.com")).toBe("every-app-gateway");
    // Still the app's Worker, so it stays bound.
    expect(account.gatewayBindings()).toEqual(["every-acme-talk"]);

    // The old id is no new app's.
    const taken = await errorOf(deploy(TALK));
    expect(taken.code).toBe("APP_ID_RENAMED");

    // Listing it again serves it again.
    await deploy(SCRIBE);
    expect(previousIds()[0]!["retired_at"]).toBeNull();
    expect(account.customDomains.get("talk.example.com")).toBe("every-app-gateway");
  });

  it("refuses what isn't the rename of one app, before anything changes", async () => {
    // Nothing on the Gateway answers to talk: never a new app.
    const unknown = await errorOf(deploy(SCRIBE, { yes: true }));
    expect(unknown.code).toBe("PREVIOUS_ID_UNKNOWN");
    expect(appRows()).toEqual([]);

    await deploy(TALK);
    await deploy({ ...TALK, id: "scribe", name: "Scribe" });
    const before = appRows();
    // Both are apps: no merging.
    expect((await errorOf(deploy(SCRIBE, { yes: true }))).code).toBe("RENAME_TARGET_EXISTS");
    // Two apps named as previous ids.
    expect(
      (await errorOf(deploy({ ...TALK, id: "notes", previousIds: ["talk", "scribe"] }, { yes: true }))).code,
    ).toBe("RENAME_AMBIGUOUS");
    // A registered app listing an id it never had.
    expect((await errorOf(deploy({ ...TALK, previousIds: ["nope"] }))).code).toBe("PREVIOUS_ID_UNKNOWN");
    expect(appRows()).toEqual(before);
    expect(previousIds()).toEqual([]);
  });
});
