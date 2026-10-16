import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GATEWAY_WORKER_CONFIG,
  gatewayDomains,
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
  appBaseDomain: "apps.example.com",
  appWorkers: ["every-todo", "every-acme-chef", "every-todo"],
  appHosts: [
    "todo.apps.example.com",
    "chef-acme.apps.example.com",
    "todo.apps.example.com",
  ],
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

  it("publishes the gateway host and each app host as Custom Domains, with no route", async () => {
    const config = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    config.triggers = [
      { type: "scheduled", schedule: "17 3 * * *" },
      { type: "fetch", pattern: "*.old.example.com/*", zone: "old" },
    ];
    writeRelease("worker.config.json", JSON.stringify(config));

    const patched = await patchGatewayBuildOutput(releaseDir, PATCH);
    // The full list, every time: cf removes a host left out of it.
    expect(patched.domains).toEqual([
      "apps.example.com",
      "chef-acme.apps.example.com",
      "todo.apps.example.com",
    ]);
    expect(patched.triggers).toEqual([
      { type: "scheduled", schedule: "17 3 * * *" },
    ]);
    expect(patched.env!["APP_BASE_DOMAIN"]).toEqual({
      type: "text",
      value: "apps.example.com",
    });
  });

  it("refuses to publish a host that isn't one label below the base domain", async () => {
    for (const host of [
      "www.example.com",
      "deep.todo.apps.example.com",
      "apps.example.com.evil.net",
    ]) {
      await expect(
        patchGatewayBuildOutput(releaseDir, { ...PATCH, appHosts: [host] }),
      ).rejects.toMatchObject({ code: "INVALID_APP_HOST" });
    }
    await expect(
      patchGatewayBuildOutput(releaseDir, {
        ...PATCH,
        gatewayHost: "home.example.com",
      }),
    ).rejects.toMatchObject({ code: "INVALID_APP_BASE_DOMAIN" });
  });

  it("sets APP_BASE_DOMAIN to the gateway host only, never a domain above it", async () => {
    // The gateway's session cookie is scoped to it: example.com would hand
    // it to every name in the company's zone.
    await expect(
      patchGatewayBuildOutput(releaseDir, {
        ...PATCH,
        gatewayHost: "apps.example.com",
        appBaseDomain: "example.com",
        appHosts: ["todo.example.com"],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_APP_BASE_DOMAIN",
      message: expect.stringContaining(
        "must be apps.example.com, not example.com",
      ),
    });
  });
});

describe("gatewayDomains", () => {
  it("puts the gateway host first, then each app host once, sorted", () => {
    expect(
      gatewayDomains({
        gatewayHost: "apps.example.com",
        appHosts: ["b.apps.example.com", "a.apps.example.com", "b.apps.example.com"],
      }),
    ).toEqual(["apps.example.com", "a.apps.example.com", "b.apps.example.com"]);
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
    // What a CLI that predates APP_BASE_DOMAIN leaves in the release.
    const older = valid();
    older.env.APP_BASE_DOMAIN.value = "__EVERYAPP_PATCH__";
    expect(() => validateWorkerConfig(older)).toThrow(/placeholder/);
  });

  it("refuses a gateway with no domain", () => {
    const config = valid();
    delete config.domains;
    expect(() => validateWorkerConfig(config, { requireDomain: true })).toThrow(
      /no domain/,
    );
  });
});
