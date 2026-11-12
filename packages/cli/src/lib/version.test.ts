import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkoutCommit, cliVersion, compareVersions, readCliPackage, versionLine } from "./version";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the version line", () => {
  it("is the name and version from an installed package", () => {
    expect(checkoutCommit(null)).toBeNull();
    expect(versionLine(null)).toBe(`everyapp ${cliVersion}`);
  });

  it("names the commit from a checkout", () => {
    expect(versionLine("6afd18bb")).toBe(`everyapp ${cliVersion} (checkout 6afd18bb)`);
    expect(checkoutCommit()).toMatch(/^[0-9a-f]{8,}$/);
  });

  it("says no commit for a directory git can't read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-nogit-"));
    dirs.push(dir);
    expect(checkoutCommit(dir)).toBeNull();
  });
});

describe("the CLI's version", () => {
  it("is its package.json's, read at run time", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(cliVersion).toBe(pkg.version);
  });

  it("comes from the installed package's package.json, so a bump after the build is what it says", () => {
    // A published package: package.json beside a flat dist/ of chunks.
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-pkg-"));
    dirs.push(pkg);
    fs.mkdirSync(path.join(pkg, "dist"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "everyapp", version: "0.3.0" }));
    const chunk = pathToFileURL(path.join(pkg, "dist", "chunk-ABC.js")).href;
    expect(readCliPackage(chunk)).toEqual({ name: "everyapp", version: "0.3.0" });

    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "everyapp", version: "0.3.0-rc.7" }));
    expect(readCliPackage(chunk).version).toBe("0.3.0-rc.7");
  });

  it("skips a package.json that isn't everyapp's, such as a dependency's or an app's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-nested-"));
    dirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "everyapp", version: "1.2.3" }));
    fs.mkdirSync(path.join(root, "dist", "inner"), { recursive: true });
    fs.writeFileSync(path.join(root, "dist", "package.json"), JSON.stringify({ type: "module" }));
    expect(readCliPackage(pathToFileURL(path.join(root, "dist", "inner", "x.js")).href).version).toBe("1.2.3");
  });
});

describe("compareVersions", () => {
  it("orders dotted versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "v0.2.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
    expect(compareVersions("22.18.0", "22.9.0")).toBeGreaterThan(0);
  });

  it("orders prereleases: rc.9 before rc.10, every rc before the release", () => {
    expect(compareVersions("0.3.0-rc.9", "0.3.0-rc.10")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc.10", "0.3.0-rc.10")).toBe(0);
    expect(compareVersions("0.3.0-rc.10", "0.3.0")).toBeLessThan(0);
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.3.1-rc.1", "0.3.0")).toBeGreaterThan(0);
    expect(compareVersions("0.3.0-beta.2", "0.3.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc", "0.3.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc.1+abc", "0.3.0-rc.1")).toBe(0);
  });
});
