import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cliVersion, readCliPackage } from "./version";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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
