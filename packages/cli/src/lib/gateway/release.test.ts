import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCf } from "@/lib/cf/fakeCf";
import {
  cacheRelease,
  compareVersions,
  fetchCachedRelease,
  hashReleaseTree,
  openRelease,
} from "./release";

// The gateway's own release builder, loaded by path: it is another package.
const BUILDER = "../../../../../apps/every-app-gateway/scripts/build-release.ts";
interface Builder {
  stageRelease(options: {
    gatewayDir: string;
    stageDir: string;
    build: Record<string, string>;
  }): { sha256: string; version: string };
  hashTree(root: string): string;
}

let work: string;
let tarball: string;
let stageDir: string;

function write(root: string, file: string, content: string | object): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
}

/** A gateway source tree with a production Build Output, as `cf build` leaves it. */
function gatewaySource(dir: string): void {
  write(dir, ".cloudflare/output/v0/config.json", {
    buildContext: { isPreview: false, mode: "production" },
  });
  write(dir, ".cloudflare/output/v0/workers/default/worker.config.json", {
    name: "every-app-gateway",
    compatibilityDate: "2025-09-02",
    env: {
      DB: { type: "d1", name: "every-app-gateway" },
      EVERYAPP_RELEASE: {
        type: "json",
        value: { version: "__EVERYAPP_PATCH__", sha256: "__EVERYAPP_PATCH__" },
      },
      APP_BASE_DOMAIN: { type: "text", value: "__EVERYAPP_PATCH__" },
    },
    manifest: { type: "partial", mainModule: "index.js", modules: {} },
  });
  write(dir, ".cloudflare/output/v0/workers/default/bundle/index.js", "export {}");
  write(dir, "drizzle/0000_init.sql", "CREATE TABLE a (id text);");
  write(dir, "drizzle/meta/_journal.json", {
    entries: [{ tag: "0000_init", when: 1000 }],
  });
}

beforeEach(async () => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-test-"));
  const source = path.join(work, "gateway");
  stageDir = path.join(work, "stage");
  gatewaySource(source);
  const builder = (await import(/* @vite-ignore */ BUILDER)) as Builder;
  builder.stageRelease({
    gatewayDir: source,
    stageDir,
    build: {
      version: "0.2.0",
      gitSha: "abc",
      builtAt: "2026-10-12T00:00:00.000Z",
      cfVersion: "1.0.0-beta.14",
      pluginVersion: "2.0.0-beta.sha-91c870c02",
      configVersion: "0.24.1",
      minCli: "0.3.0",
      minSdk: "0.3.0",
    },
  });
  tarball = path.join(work, "every-app-gateway-release.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", stageDir, "."]);
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

function repack(change: (dir: string) => void): void {
  change(stageDir);
  execFileSync("tar", ["-czf", tarball, "-C", stageDir, "."]);
}

describe("openRelease", () => {
  it("opens a release the gateway's builder packed, and agrees on its hash", async () => {
    const builder = (await import(/* @vite-ignore */ BUILDER)) as Builder;
    const release = await openRelease(tarball);
    try {
      expect(release.manifest).toMatchObject({
        version: "0.2.0",
        buildOutputVersion: "v0",
        migrations: [{ tag: "0000_init", when: 1000 }],
      });
      expect(await hashReleaseTree(release.dir)).toBe(builder.hashTree(stageDir));
      expect(release.manifest.sha256).toBe(builder.hashTree(stageDir));
    } finally {
      await release.cleanup();
    }
    expect(fs.existsSync(release.dir)).toBe(false);
  });

  it("refuses a release whose files changed after it was built", async () => {
    repack((dir) =>
      fs.appendFileSync(path.join(dir, "drizzle/0000_init.sql"), "DROP TABLE a;"),
    );
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_CORRUPT",
    });
  });

  it("refuses a release with more than its own files at the top", async () => {
    // cf deploys from a copy of the release and would run this.
    repack((dir) => fs.writeFileSync(path.join(dir, "cloudflare.config.ts"), "export default {};"));
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringContaining("cloudflare.config.ts"),
    });
  });

  it("refuses a Build Output version this CLI doesn't deploy", async () => {
    repack((dir) => {
      const file = path.join(dir, "release.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...manifest, buildOutputVersion: "v1" }));
    });
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_UNSUPPORTED",
    });
  });

  it("refuses a tarball that isn't a release", async () => {
    repack((dir) => fs.rmSync(path.join(dir, "release.json")));
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
    });
  });
});

describe("the release cache", () => {
  const KV = "0123456789abcdef0123456789abcdef";

  it("stores the tarball once and hands back the same release", async () => {
    const store = new Map<string, string>();
    const cf = new FakeCf()
      .on(["kv", "keys", "list"], (call) => ({
        stdout: JSON.stringify(
          [...store.keys()]
            .filter((key) => key.startsWith(call.args.at(-1)!))
            .map((name) => ({ name })),
        ),
      }))
      .on(["kv", "keys", "put"], (call) => {
        store.set(call.args[3]!, call.files["release.b64"]!);
        return { stdout: "{}" };
      })
      .on(["kv", "keys", "get"], (call) => {
        const value = store.get(call.args[3]!);
        return value === undefined
          ? { exitCode: 1, stderr: "┌ Error\n│ get: 'key not found' [code: 10009]\n└\n" }
          : { stdout: value };
      });
    const release = await openRelease(tarball);
    try {
      await expect(cacheRelease(cf, KV, release)).resolves.toBe("stored");
      await expect(cacheRelease(cf, KV, release)).resolves.toBe("present");
      expect([...store.keys()]).toEqual([`release/${release.manifest.sha256}`]);

      const cached = await fetchCachedRelease(cf, KV, release.manifest.sha256);
      expect(cached?.manifest).toEqual(release.manifest);
      await cached?.cleanup();

      await expect(fetchCachedRelease(cf, KV, "f".repeat(64))).resolves.toBeNull();
    } finally {
      await release.cleanup();
    }
  });

  it("refuses a cached tarball that isn't the release its key names", async () => {
    const other = fs.readFileSync(tarball).toString("base64");
    const cf = new FakeCf().on(["kv", "keys", "get"], { stdout: other });

    await expect(
      fetchCachedRelease(cf, KV, "e".repeat(64)),
    ).rejects.toMatchObject({ code: "RELEASE_CACHE_MISMATCH" });
  });
});

describe("compareVersions", () => {
  it("orders dotted versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
  });
});
