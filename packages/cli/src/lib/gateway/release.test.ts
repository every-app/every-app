import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareVersions, hashReleaseTree, openRelease, refuseNewerThanCli } from "./release";

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

  it.each([
    [
      "a symbolic link",
      (dir: string) =>
        fs.symlinkSync(
          "../../../../../../../../.ssh/id_ed25519",
          path.join(dir, ".cloudflare/output/v0/workers/default/bundle/leak.txt"),
        ),
    ],
    [
      "a hard link",
      (dir: string) =>
        fs.linkSync(
          path.join(dir, "drizzle/0000_init.sql"),
          path.join(dir, ".cloudflare/output/v0/workers/default/bundle/leak.sql"),
        ),
    ],
  ])("refuses a release holding %s, which cf would upload as what it points at", async (_case, plant) => {
    // Neither is a regular file, so neither counts in the hash release.json
    // records: the publisher's hash still matches. The archive is refused.
    repack(plant);
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringMatching(/link/),
    });
  });

  it("refuses a release whose Worker lists a module outside its bundle", async () => {
    repack((dir) => {
      const file = path.join(dir, ".cloudflare/output/v0/workers/default/worker.config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.manifest.modules = {
        "../../../../../../../../.ssh/id_ed25519": { type: "text" },
      };
      fs.writeFileSync(file, JSON.stringify(config));
    });
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringContaining("outside its bundle"),
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

  it("refuses a release of something other than the Gateway, and reads one that doesn't say as the Gateway", async () => {
    const rewrite = (change: (manifest: Record<string, unknown>) => void) =>
      repack((dir) => {
        const file = path.join(dir, "release.json");
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        change(manifest);
        fs.writeFileSync(file, JSON.stringify(manifest));
      });
    rewrite((manifest) => {
      manifest["kind"] = "app";
    });
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
      message: expect.stringContaining("is an app release, not a Gateway release"),
    });

    rewrite((manifest) => {
      delete manifest["kind"];
    });
    const release = await openRelease(tarball);
    await release.cleanup();
    expect(release.manifest.kind).toBeUndefined();
  });

  it("orders a release without a checkout by when its sources were committed, else when it was built", async () => {
    const built = await openRelease(tarball);
    await built.cleanup();
    expect(built.source).toEqual({
      treeSha256: null,
      order: { schema: 1000, committedAt: Date.parse("2026-10-12T00:00:00.000Z") },
      origin: { kind: "file", path: tarball },
    });

    repack((dir) => {
      const file = path.join(dir, "release.json");
      const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...manifest, committedAt: "2026-10-01T00:00:00.000Z" }));
    });
    const committed = await openRelease(tarball, {
      origin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.2.0" },
    });
    await committed.cleanup();
    expect(committed.source.order.committedAt).toBe(Date.parse("2026-10-01T00:00:00.000Z"));
    expect(committed.source.origin).toEqual({
      kind: "github",
      repo: "every-app/every-app",
      tag: "gateway-v0.2.0",
    });
  });

  it("refuses a tarball that isn't a release", async () => {
    repack((dir) => fs.rmSync(path.join(dir, "release.json")));
    await expect(openRelease(tarball)).rejects.toMatchObject({
      code: "RELEASE_INVALID",
    });
  });
});

describe("refuseNewerThanCli", () => {
  it("refuses a release that needs a newer everyapp, and says to update it", () => {
    expect(() => refuseNewerThanCli({ version: "0.4.0", minCli: "0.3.0" }, "0.3.0")).not.toThrow();
    expect(() => refuseNewerThanCli({ version: "0.4.0", minCli: "0.4.0" }, "0.3.0")).toThrow(
      expect.objectContaining({
        code: "CLI_TOO_OLD",
        message: expect.stringContaining("needs everyapp 0.4.0 or newer (this is 0.3.0)"),
        fix: "update everyapp (in a checkout: git pull), then run this again",
      }),
    );
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
