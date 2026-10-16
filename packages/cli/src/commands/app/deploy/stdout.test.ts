/**
 * `everyapp app deploy --json`'s stdout is NDJSON and nothing else: the
 * CLI's own lines, pnpm's and the manifest commands' output (a real child
 * here) and cf's never land there. Against the same fake Cloudflare account
 * and gateway Worker as deployApp.test.ts.
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
import { reportFailure } from "@/lib/output/report";
import { ACCOUNT_ID, FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { GatewayWorker } from "@/test/gatewayWorker";
import { makeTestHome } from "@/test/home";
import { deployApp } from "./deployApp";

/** A dependency install that talks a lot, on both streams. */
const CHATTY_INSTALL = `node -e "for (let i = 1; i <= 30; i++) console.log('install line ' + i); console.error('WARN deprecated');"`;

const TODO: EveryAppCliManifest = {
  id: "todo",
  resources: { d1: ["DB"] },
  install: CHATTY_INSTALL,
};

let account: FakeCloudflare;
let worker: GatewayWorker;
let release: GatewayRelease;
let appDir: string;
let home: string;
let stdout: string;
let stderr: string;

const seams = {
  sleep: async () => undefined,
  leaseWaitMs: 0,
};

beforeEach(async () => {
  home = makeTestHome();
  vi.stubEnv("HOME", home);
  account = new FakeCloudflare();
  worker = new GatewayWorker(account);
  release = await openRelease(await buildGatewayRelease());
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
  fs.writeFileSync(
    path.join(appDir, "cloudflare.config.ts"),
    "everyAppWorker\n",
  );
  fs.mkdirSync(path.join(appDir, "drizzle"));
  fs.writeFileSync(
    path.join(appDir, "drizzle", "0000_init.sql"),
    "CREATE TABLE todos (id text PRIMARY KEY);",
  );

  // Everything this process writes, as a terminal or a pipe would get it.
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  for (const method of ["log", "info", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      stdout += `${args.join(" ")}\n`;
    });
  }
  for (const method of ["warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      stderr += `${args.join(" ")}\n`;
    });
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  await release.cleanup();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(appDir, { recursive: true, force: true });
});

/** `everyapp app deploy --json [--verbose]`, as the command runs it, with fakes. */
async function deployJson(manifest: EveryAppCliManifest, verbose = false) {
  account.apps.set(appDir, manifest);
  const out = createNdjsonSink();
  try {
    const result = await deployApp({
      cwd: appDir,
      manifest,
      out,
      json: true,
      verbose,
      createCf: () => account.cf,
      live: { fetch: worker.fetch, sleep: async () => undefined },
      reconcile: seams,
    });
    out.emit({ type: "done", data: { url: result.liveUrl } });
  } catch (error) {
    reportFailure(out, error);
  }
  return out.exitCode;
}

/** stdout, parsed: every line must be one JSON event. */
function events(): Array<Record<string, any>> {
  return stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

describe("app deploy --json", () => {
  it("writes only NDJSON events to stdout, even with --verbose", async () => {
    expect(await deployJson(TODO, true)).toBe(0);

    expect(stdout.endsWith("\n")).toBe(true);
    const parsed = events();
    expect(
      parsed.every(
        (event) => event["v"] === 1 && typeof event["type"] === "string",
      ),
    ).toBe(true);
    expect(parsed.at(-1)).toMatchObject({ type: "done" });
    expect(stdout).not.toContain("install line");
    expect(stdout).not.toContain("Build complete");
    // --verbose streams the children's output to stderr instead.
    expect(stderr).toContain("install line 30");
    expect(stderr).toContain("WARN deprecated");
  });

  it("keeps a failed child's output in a log file, and shows its last 20 lines", async () => {
    const failing = {
      ...TODO,
      install: `${CHATTY_INSTALL.slice(0, -1)} process.exit(3);"`,
    };

    expect(await deployJson(failing)).toBe(1);

    const parsed = events();
    const error = parsed.at(-1)!;
    expect(error).toMatchObject({ type: "error", code: "INSTALL_FAILED" });
    const message = String(error["message"]);
    expect(message).toContain("install line 30");
    expect(message).toContain("WARN deprecated");
    expect(message).not.toContain("install line 10\n");
    const log = message.match(/Full log: (\S+\.log)/)?.[1];
    expect(log).toBeDefined();
    expect(path.dirname(log!)).toBe(path.join(os.tmpdir(), "everyapp"));
    const written = fs.readFileSync(log!, "utf8");
    expect(written).toContain("install line 1\n");
    expect(written).toContain("install line 30");
    fs.rmSync(log!, { force: true });
    // Without --verbose nothing of it reached stderr either.
    expect(stderr).toBe("");
  });
});
