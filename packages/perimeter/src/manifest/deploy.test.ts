import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appBindingName, appBindingsDigest, bundleModuleType } from "./deploy";

describe("appBindingsDigest", () => {
  it("hashes the sorted binding names, whatever order they come in", async () => {
    const names = [appBindingName("every-b"), appBindingName("every-a")];
    const expected = createHash("sha256")
      .update("APP__every-a\nAPP__every-b")
      .digest("hex");

    await expect(appBindingsDigest(names)).resolves.toBe(expected);
    await expect(appBindingsDigest([...names].reverse())).resolves.toBe(
      expected,
    );
  });

  it("has a digest for no apps", async () => {
    await expect(appBindingsDigest([])).resolves.toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });
});

describe("bundleModuleType", () => {
  it("types a bundle file as cf's default rules do, a declared type first", () => {
    expect(bundleModuleType("index.js")).toBe("esm");
    expect(bundleModuleType("chunks/a.mjs")).toBe("esm");
    expect(bundleModuleType("index.js.map")).toBe("sourcemap");
    expect(bundleModuleType("query.wasm")).toBe("wasm");
    expect(bundleModuleType("schema.sql")).toBe("text");
    expect(bundleModuleType(".vite/manifest.json")).toBeNull();
    expect(bundleModuleType("legacy.js", "cjs")).toBe("cjs");
    expect(bundleModuleType("index.js", "python")).toBeNull();
  });
});
