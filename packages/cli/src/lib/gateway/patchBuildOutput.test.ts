import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATEWAY_WORKER_CONFIG,
  patchGatewayBuildOutput,
  validateWorkerConfig,
} from "./patchBuildOutput";

// worker.config.json exactly as `cf build` wrote it for the gateway.
const FIXTURE = path.join(import.meta.dirname, "__fixtures__", "gateway-worker.config.json");
const GOLDEN = path.join(
  import.meta.dirname,
  "__fixtures__",
  "gateway-worker.config.patched.json",
);

const PATCH = {
  d1Id: "11111111-2222-4333-8444-555555555555",
  oauthKvId: "0123456789abcdef0123456789abcdef",
  release: { version: "0.2.0", sha256: "a".repeat(64) },
  gatewayHost: "apps.example.com",
  zoneId: "fedcba9876543210fedcba9876543210",
  appWorkers: ["every-todo", "every-acme-chef", "every-todo"],
};

let releaseDir: string;

function writeRelease(file: string, content: string): void {
  const target = path.join(releaseDir, ".cloudflare/output/v0/workers/default", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

beforeEach(() => {
  releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-"));
  writeRelease("worker.config.json", fs.readFileSync(FIXTURE, "utf8"));
  writeRelease("bundle/index.js", "export {}");
  writeRelease("bundle/index.js.map", "{}");
  writeRelease("bundle/assets/index-abc.js", "export {}");
  writeRelease("bundle/assets/index-abc.js.map", "{}");
  writeRelease("bundle/.vite/manifest.json", "{}");
});

afterEach(() => fs.rmSync(releaseDir, { recursive: true, force: true }));

describe("patchGatewayBuildOutput", () => {
  it("matches the golden patched config", async () => {
    const patched = await patchGatewayBuildOutput(releaseDir, PATCH);

    if (process.env["UPDATE_GOLDEN"]) {
      fs.writeFileSync(GOLDEN, `${JSON.stringify(patched, null, 2)}\n`);
    }
    expect(patched).toEqual(JSON.parse(fs.readFileSync(GOLDEN, "utf8")));
    // Written back for cf to read.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(releaseDir, GATEWAY_WORKER_CONFIG), "utf8"),
      ),
    ).toEqual(patched);
  });

  it("binds each app Worker once, sorted, and drops stale app bindings and KV", async () => {
    const config = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    config.env["APP__every-gone"] = { type: "worker", worker: "every-gone" };
    config.env.KV = { type: "kv" };
    writeRelease("worker.config.json", JSON.stringify(config));

    const patched = await patchGatewayBuildOutput(releaseDir, PATCH);
    const appBindings = Object.entries(patched.env!).filter(([name]) =>
      name.startsWith("APP__"),
    );

    expect(appBindings).toEqual([
      ["APP__every-acme-chef", { type: "worker", worker: "every-acme-chef" }],
      ["APP__every-todo", { type: "worker", worker: "every-todo" }],
    ]);
    expect(patched.env!["KV"]).toBeUndefined();
  });

  it("lists every source map as a sourcemap module", async () => {
    const patched = await patchGatewayBuildOutput(releaseDir, PATCH);
    expect(patched.manifest).toEqual({
      type: "partial",
      mainModule: "index.js",
      modules: {
        "assets/index-abc.js.map": { type: "sourcemap" },
        "index.js.map": { type: "sourcemap" },
      },
    });
  });

  it("keeps the gateway's other triggers and replaces only its route", async () => {
    const config = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    config.triggers = [
      { type: "scheduled", schedule: "17 3 * * *" },
      { type: "fetch", pattern: "*.old.example.com/*", zone: "old" },
    ];
    writeRelease("worker.config.json", JSON.stringify(config));

    const patched = await patchGatewayBuildOutput(releaseDir, PATCH);
    expect(patched.triggers).toEqual([
      { type: "scheduled", schedule: "17 3 * * *" },
      {
        type: "fetch",
        pattern: "*.apps.example.com/*",
        zone: PATCH.zoneId,
      },
    ]);
  });
});

describe("validateWorkerConfig", () => {
  const valid = () => JSON.parse(fs.readFileSync(GOLDEN, "utf8"));

  it("accepts the patched gateway", () => {
    expect(() => validateWorkerConfig(valid(), { requireDomain: true })).not.toThrow();
  });

  it("refuses what cf's schema refuses", () => {
    const config = valid();
    config.env["APP__x"] = { type: "worker" };
    expect(() => validateWorkerConfig(config)).toThrow(
      /isn't valid Build Output: env\.APP__x\.worker/,
    );
    expect(() => validateWorkerConfig({ ...valid(), surprise: true })).toThrow(
      /isn't valid Build Output/,
    );
  });

  it("refuses a leftover deploy-time placeholder", () => {
    const config = valid();
    config.env.EVERYAPP_RELEASE.value.version = "__EVERYAPP_PATCH__";
    expect(() => validateWorkerConfig(config)).toThrow(/placeholder/);
  });

  it("refuses a gateway with no domain", () => {
    const config = valid();
    delete config.domains;
    expect(() => validateWorkerConfig(config, { requireDomain: true })).toThrow(
      /no domain/,
    );
  });
});
