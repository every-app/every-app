import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashTree, stageRelease } from "./build-release.ts";

const BUILD = {
  version: "0.2.0",
  gitSha: "abc123",
  builtAt: "2026-10-12T00:00:00.000Z",
  cfVersion: "1.0.0-beta.14",
  pluginVersion: "2.0.0-beta.sha-91c870c02",
  configVersion: "0.24.1",
  minCli: "0.3.0",
  minSdk: "0.3.0",
};

/** The production gateway worker.config.json `cf build` writes, trimmed. */
const WORKER_CONFIG = {
  name: "every-app-gateway",
  compatibilityDate: "2025-09-02",
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  assets: { runWorkerFirst: true },
  workersDev: false,
  previewUrls: false,
  // The hourly MCP housekeeping: the release's own, kept by every deploy.
  triggers: [{ type: "scheduled", schedule: "17 * * * *" }],
  env: {
    ASSETS: { type: "assets" },
    DB: { type: "d1", name: "every-app-gateway" },
    OAUTH_KV: { type: "kv" },
    GATEWAY_URL: { type: "secret" },
    EVERYAPP_RELEASE: {
      type: "json",
      value: { version: "__EVERYAPP_PATCH__", sha256: "__EVERYAPP_PATCH__" },
    },
    APP_BASE_DOMAIN: { type: "text", value: "__EVERYAPP_PATCH__" },
  },
  manifest: { type: "partial", mainModule: "index.js", modules: {} },
};

let gatewayDir: string;
let stageDir: string;

function write(file: string, content: string | object): void {
  const target = path.join(gatewayDir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

function workerConfig(change: (config: any) => void): void {
  const config = structuredClone(WORKER_CONFIG);
  change(config);
  write(".cloudflare/output/v0/workers/default/worker.config.json", config);
}

function stagedFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(stageDir, dir), {
      withFileTypes: true,
    })) {
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relative);
      else files.push(relative);
    }
  };
  walk("");
  return files.sort();
}

beforeEach(() => {
  gatewayDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-src-"));
  stageDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gateway-stage-")),
    "release",
  );
  write(".cloudflare/output/v0/config.json", {
    buildContext: { isPreview: false, mode: "production" },
  });
  workerConfig(() => undefined);
  write(".cloudflare/output/v0/workers/default/bundle/index.js", "export {}");
  write(
    ".cloudflare/output/v0/workers/default/bundle/assets/index-abc.js.map",
    "{}",
  );
  write(".cloudflare/output/v0/workers/default/assets/_shell.html", "<html>");
  // Local dev state and types next to the output never ship.
  write(".cloudflare/state/v3/d1/db.sqlite", "real users");
  write(".cloudflare/types/index.d.ts", "declare const x: 1;");
  write(".dev.vars", "BETTER_AUTH_SECRET=local");
  write("drizzle/0000_init.sql", "CREATE TABLE a (id text);");
  write("drizzle/0001_more.sql", "CREATE TABLE b (id text);");
  write("drizzle/meta/0000_snapshot.json", "{}");
  write("drizzle/meta/_journal.json", {
    entries: [
      { idx: 0, tag: "0000_init", when: 1000, breakpoints: true },
      { idx: 1, tag: "0001_more", when: 2000, breakpoints: true },
    ],
  });
});

afterEach(() => {
  fs.rmSync(gatewayDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(stageDir), { recursive: true, force: true });
});

describe("stageRelease", () => {
  it("stages only the Build Output, the migrations and release.json", () => {
    const manifest = stageRelease({ gatewayDir, stageDir, build: BUILD });

    expect(stagedFiles()).toEqual([
      ".cloudflare/output/v0/config.json",
      ".cloudflare/output/v0/workers/default/assets/_shell.html",
      ".cloudflare/output/v0/workers/default/bundle/assets/index-abc.js.map",
      ".cloudflare/output/v0/workers/default/bundle/index.js",
      ".cloudflare/output/v0/workers/default/worker.config.json",
      "drizzle/0000_init.sql",
      "drizzle/0001_more.sql",
      "release.json",
    ]);
    expect(manifest).toEqual({
      schema: 1,
      ...BUILD,
      buildOutputVersion: "v0",
      sha256: hashTree(stageDir),
      migrations: [
        { tag: "0000_init", when: 1000 },
        { tag: "0001_more", when: 2000 },
      ],
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(stageDir, "release.json"), "utf8")),
    ).toEqual(manifest);
  });

  it("hashes the staged tree the same way every time, and notices a change", () => {
    const first = stageRelease({ gatewayDir, stageDir, build: BUILD });
    const again = stageRelease({
      gatewayDir,
      stageDir,
      build: { ...BUILD, builtAt: "2026-10-13T00:00:00.000Z" },
    });
    expect(again.sha256).toBe(first.sha256);

    write("drizzle/0002_new.sql", "CREATE TABLE c (id text);");
    expect(
      stageRelease({ gatewayDir, stageDir, build: BUILD }).sha256,
    ).not.toBe(first.sha256);
  });

  it("refuses a Build Output that carries an install's bindings, domains or routes", () => {
    for (const change of [
      (c: any) => (c.env["APP__every-todo"] = { type: "worker", worker: "x" }),
      (c: any) => (c.domains = ["gateway.example.com"]),
      (c: any) =>
        c.triggers.push({ type: "fetch", pattern: "*.gateway.example.com/*" }),
      (c: any) => (c.env.OAUTH_KV.id = "0123"),
      (c: any) => (c.env.DB.id = "0123"),
      (c: any) =>
        (c.env.EVERYAPP_RELEASE.value = { version: "1", sha256: "x" }),
      (c: any) => (c.env.APP_BASE_DOMAIN.value = "apps.example.com"),
      (c: any) => delete c.env.APP_BASE_DOMAIN,
    ]) {
      workerConfig(change);
      expect(() =>
        stageRelease({ gatewayDir, stageDir, build: BUILD }),
      ).toThrow(/isn't a clean gateway release/);
    }
  });

  it("refuses a development build", () => {
    write(".cloudflare/output/v0/config.json", {
      buildContext: { isPreview: false, mode: "development" },
    });
    expect(() => stageRelease({ gatewayDir, stageDir, build: BUILD })).toThrow(
      /isn't a production build/,
    );
  });

  it("refuses to ship secrets that ended up in the Build Output", () => {
    write(".cloudflare/output/v0/workers/default/assets/.dev.vars", "x=1");
    write(".cloudflare/output/v0/workers/default/bundle/key.pem", "-----");
    expect(() => stageRelease({ gatewayDir, stageDir, build: BUILD })).toThrow(
      /\.dev\.vars[\s\S]*key\.pem/,
    );
  });
});
