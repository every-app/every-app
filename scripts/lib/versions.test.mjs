// pnpm test:scripts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_JSONS,
  SDK_VERSION_FILE,
  compareVersions,
  currentVersion,
  nextVersion,
  readVersions,
  writeVersion,
} from "./versions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("nextVersion", () => {
  it("bumps patch, minor and major; a prerelease's patch is its release", () => {
    assert.equal(nextVersion("0.3.0-rc.15", "patch"), "0.3.0");
    assert.equal(nextVersion("0.3.0", "patch"), "0.3.1");
    assert.equal(nextVersion("0.3.1", "minor"), "0.4.0");
    assert.equal(nextVersion("0.3.0-rc.15", "minor"), "0.3.0");
    assert.equal(nextVersion("0.3.1-rc.1", "minor"), "0.4.0");
    assert.equal(nextVersion("0.3.1", "major"), "1.0.0");
    assert.equal(nextVersion("1.0.0-rc.1", "major"), "1.0.0");
    assert.equal(nextVersion("1.2.0-rc.1", "major"), "2.0.0");
  });

  it("takes an exact version only when it is newer", () => {
    assert.equal(nextVersion("0.3.0-rc.15", "0.3.0-rc.16"), "0.3.0-rc.16");
    assert.equal(nextVersion("0.3.0-rc.9", "0.3.0-rc.10"), "0.3.0-rc.10");
    assert.throws(() => nextVersion("0.3.0", "0.3.0-rc.16"), /isn't newer/);
    assert.throws(() => nextVersion("0.3.0", "0.3.0"), /isn't newer/);
    assert.throws(() => nextVersion("0.3.0", "next"), /isn't patch, minor, major or a version/);
  });
});

describe("compareVersions", () => {
  it("orders as semver does", () => {
    const sorted = ["0.3.0", "0.3.0-rc.10", "0.2.9", "0.3.0-rc.9", "0.3.1", "0.3.0-rc.9.1"].sort(compareVersions);
    assert.deepEqual(sorted, ["0.2.9", "0.3.0-rc.9", "0.3.0-rc.9.1", "0.3.0-rc.10", "0.3.0", "0.3.1"]);
  });
});

describe("the repository's version", () => {
  it("is one version in every file", () => {
    const version = currentVersion(ROOT);
    assert.deepEqual(new Set(Object.values(readVersions(ROOT))), new Set([version]));
  });

  it("writeVersion changes only the version, in every file", () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "release-versions-"));
    try {
      for (const file of [...PACKAGE_JSONS, SDK_VERSION_FILE]) {
        fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(copy, file));
      }
      const before = currentVersion(copy);
      writeVersion(copy, "9.8.7");
      assert.equal(currentVersion(copy), "9.8.7");
      for (const file of [...PACKAGE_JSONS, SDK_VERSION_FILE]) {
        const diff = spawnDiff(path.join(ROOT, file), path.join(copy, file));
        assert.equal(diff.length, 1, `${file}: ${diff.join(" | ")}`);
        assert.ok(diff[0].includes(before) || diff[0].includes("9.8.7"));
      }
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });

  it("currentVersion names the files that disagree", () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "release-versions-"));
    try {
      for (const file of [...PACKAGE_JSONS, SDK_VERSION_FILE]) {
        fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), path.join(copy, file));
      }
      const gateway = path.join(copy, "apps/every-app-gateway/package.json");
      fs.writeFileSync(gateway, fs.readFileSync(gateway, "utf8").replace(/"version": "[^"]*"/, '"version": "0.0.1"'));
      assert.throws(() => currentVersion(copy), /apps\/every-app-gateway\/package\.json: 0\.0\.1/);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});

/** The changed lines between two files, as `git diff --no-index` sees them (the new side). */
function spawnDiff(a, b) {
  let out = "";
  try {
    execFileSync("git", ["diff", "--no-index", "--unified=0", a, b], { encoding: "utf8" });
  } catch (error) {
    out = error.stdout;
  }
  return out.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++"));
}
