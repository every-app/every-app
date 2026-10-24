/**
 * What a person reads from `everyapp deploy` (piped, no color): the same
 * fake Cloudflare account and gateway Worker as deployApp.test.ts, drawn
 * through the human sink.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfD1Database } from "@/lib/cf/d1";
import { applyGateway } from "@/lib/gateway/apply";
import { openRelease, type GatewayRelease } from "@/lib/gateway/release";
import { ensureGatewayResources } from "@/lib/gateway/resources";
import type { EveryAppCliManifest } from "@/lib/manifest";
import { createHumanSink, createNdjsonSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease, releaseSource } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

const TODO: EveryAppCliManifest = { id: "todo", resources: { d1: ["DB"] } };

let account: FakeCloudflare;
let worker: GatewayWorker;
let tarball: string;
let release: GatewayRelease;
let appDir: string;
let home: string;
let level: typeof chalk.level;

const seams = { sleep: async () => undefined, leaseWaitMs: 0 };

beforeEach(async () => {
  level = chalk.level;
  chalk.level = 0;
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
    out: createNdjsonSink(() => undefined),
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
  fs.writeFileSync(path.join(appDir, "cloudflare.config.ts"), "everyAppWorker\n");
  fs.mkdirSync(path.join(appDir, "drizzle"));
  fs.writeFileSync(
    path.join(appDir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY);",
  );
});

afterEach(async () => {
  chalk.level = level;
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

/** A deploy as a person sees it, piped: stdout and stderr. */
async function deployShown(
  manifest: EveryAppCliManifest = TODO,
  options: Partial<Parameters<typeof deployApp>[0]> = {},
) {
  let stdout = "";
  let stderr = "";
  const out = createHumanSink({
    write: (text) => void (stdout += text),
    writeProblem: (text) => void (stderr += text),
    // No step's time shows: the lines are the same however fast the run.
    now: () => 0,
  });
  account.apps.set(appDir, manifest);
  try {
    const result = await deployApp({
      cwd: appDir,
      manifest,
      out,
      createCf: () => account.cf,
      installDeps: async () => undefined,
      reconcile: { ...seams, openRelease: () => openRelease(tarball), source: () => releaseSource(tarball) },
      live: { fetch: worker.fetch, sleep: async () => undefined },
      ...options,
    });
    out.emit({ type: "done", data: { url: result.liveUrl } });
  } catch (error) {
    reportFailure(out, error);
  }
  return { stdout, stderr, exitCode: out.exitCode };
}

describe("deploy, as a person sees it", () => {
  it("heads a first deploy with where it goes, and ends with who can open the app", async () => {
    const first = await deployShown();
    expect(first.exitCode).toBe(0);
    expect(first.stdout.split("\n")).toEqual([
      "Deploying todo to example.com (Acme)",
      "Installed dependencies ✓",
      "Built ✓",
      "Database created ✓ 1 migration",
      "Uploaded ✓",
      "Added to the Gateway ✓",
      "",
      "Live    https://todo.example.com",
      "Access  Private to owners and admins · change it at https://example.com/admin/apps",
      "  The Gateway has no owner yet; its first owner gets the app (pnpm everyapp setup).",
      "",
    ]);
    expect(first.stderr).toBe(
      "! Can't check the schema against the migrations: drizzle-kit isn't installed\n  Fix: add drizzle-kit to devDependencies\n",
    );

    const again = await deployShown();
    expect(again.stdout.split("\n")).toEqual([
      "Deploying todo to example.com (Acme)",
      "Installed dependencies ✓",
      "Built ✓",
      "Database up to date ✓",
      "Uploaded ✓",
      "",
      "Live  https://todo.example.com",
      "",
    ]);
  });

  it("stays a first deploy until the app has been live once", async () => {
    // Uploaded and added, but not live yet.
    const notLive = await deployShown(TODO, { waitForLive: false });
    expect(notLive.stdout).toContain(
      "\nURL     https://todo.example.com\nStatus  Goes live on its first visit, once its certificate comes (a few minutes)\n",
    );

    const retried = await deployShown();
    expect(retried.stdout).toContain("Access  Private to owners and admins");

    const live = await deployShown(TODO, { waitForLive: false });
    expect(live.stdout).not.toContain("Access");
    expect(live.stdout).toContain("\nLive  https://todo.example.com\n");
  });

  it("says what the manifest opens to the internet, after who can open the app, on every deploy", async () => {
    const hooks: EveryAppCliManifest = {
      ...TODO,
      public: [{ path: "/hooks/*" }, { path: "/collect", methods: ["POST"] }],
    };
    const first = await deployShown(hooks);
    expect(first.stdout).toContain(
      [
        "Live    https://todo.example.com",
        "Access  Private to owners and admins · change it at https://example.com/admin/apps",
        "  The Gateway has no owner yet; its first owner gets the app (pnpm everyapp setup).",
        "Public  Open to the internet without sign-in: GET /hooks/*, POST /collect",
        "",
      ].join("\n"),
    );

    // A redeploy says it too: the first six routes, then how many more.
    const nine: EveryAppCliManifest = {
      ...TODO,
      public: [
        { path: "/hooks/*" },
        { path: "/collect", methods: ["POST"] },
        { path: "/uploads/**", methods: ["GET", "HEAD"] },
        ...["/r4", "/r5", "/r6", "/r7", "/r8", "/r9"].map((path) => ({ path })),
      ],
    };
    const again = await deployShown(nine);
    expect(again.stdout).toContain(
      [
        "Live    https://todo.example.com",
        "Public  Open to the internet without sign-in: GET /hooks/*, POST /collect, GET/HEAD /uploads/**, GET /r4, GET /r5, GET /r6 … and 3 more (everyapp.config.ts public)",
        "",
      ].join("\n"),
    );
    expect(again.stdout).not.toContain("Access");
  });

  it("says a deleted Workflow is gone, with its own ticked line", async () => {
    const withWorkflow: EveryAppCliManifest = {
      ...TODO,
      resources: { ...TODO.resources, workflows: [{ name: "RANK_CHECK", className: "RankCheckWorkflow" }] },
    };
    await deployShown(withWorkflow);
    const refused = await deployShown();
    expect(refused.exitCode).toBe(1);
    const [headline, detail, override] = refused.stderr.split("\n");
    expect([headline, detail]).toEqual([
      "✗ Deploying would delete the Workflow RANK_CHECK and its instances",
      "  everyapp.config.ts no longer declares it. Renaming a binding renames its Workflow.",
    ]);
    expect(override).toMatch(/^ {2}To go ahead anyway: pnpm everyapp .*--allow-delete-workflows$/);

    const deleted = await deployShown(TODO, { allowDeleteWorkflows: true });
    expect(deleted.stdout).toContain("Uploaded ✓\nDeleted the Workflow RANK_CHECK ✓\n");
  });
});
