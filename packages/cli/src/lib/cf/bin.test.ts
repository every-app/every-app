import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";
import { PINNED_CF_VERSION, resolveCfBinary } from "./bin";

describe("resolveCfBinary", () => {
  it("pins the exact cf version the CLI depends on", () => {
    expect(PINNED_CF_VERSION).toBe(packageJson.dependencies.cf);
    expect(PINNED_CF_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
  });

  it("uses the CLI's own cf outside a project, never a global one", async () => {
    const binary = await resolveCfBinary();
    expect(binary).toMatchObject({
      source: "cli",
      version: PINNED_CF_VERSION,
    });
    expect(binary.path).toContain(`${path.sep}node_modules${path.sep}`);
  });

  it("prefers the app's own cf for project commands", async () => {
    const app = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-cf-bin-"));
    try {
      const cfRoot = path.join(app, "node_modules", "cf");
      await fs.mkdir(path.join(cfRoot, "bin"), { recursive: true });
      await fs.writeFile(
        path.join(cfRoot, "package.json"),
        JSON.stringify({
          name: "cf",
          version: "9.9.9",
          bin: { cf: "./bin/cf" },
        }),
      );
      await fs.writeFile(path.join(cfRoot, "bin", "cf"), "");

      await expect(resolveCfBinary(app)).resolves.toEqual({
        path: await fs.realpath(path.join(cfRoot, "bin", "cf")),
        version: "9.9.9",
        source: "project",
      });
    } finally {
      await fs.rm(app, { recursive: true, force: true });
    }
  });

  it("falls back to the CLI's cf when the app has none", async () => {
    const app = await fs.mkdtemp(path.join(os.tmpdir(), "everyapp-cf-bin-"));
    try {
      await expect(resolveCfBinary(app)).resolves.toMatchObject({
        source: "cli",
      });
    } finally {
      await fs.rm(app, { recursive: true, force: true });
    }
  });
});
