import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalPackage } from "./local-package-bin";

describe("resolveLocalPackage", () => {
  it("resolves a package binary and version from the project node_modules", async () => {
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(projectRoot, "node_modules", "cf");
    await writeCfPackage(packageRoot);

    await expect(resolveLocalPackage(projectRoot, "cf", "cf")).resolves.toEqual({
      version: "1.0.0-beta.14",
      binPath: await resolvedCfBin(packageRoot),
    });
  });

  it("resolves a pnpm symlinked package binary to its real path", async () => {
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(
      projectRoot,
      "node_modules",
      ".pnpm",
      "cf@1.0.0-beta.14",
      "node_modules",
      "cf",
    );
    await writeCfPackage(packageRoot);
    const packageLink = path.join(projectRoot, "node_modules", "cf");
    await fs.symlink(packageRoot, packageLink, "dir");

    await expect(resolveLocalPackage(projectRoot, "cf", "cf")).resolves.toEqual({
      version: "1.0.0-beta.14",
      binPath: await resolvedCfBin(packageRoot),
    });
  });

  it("resolves a package installed in a parent workspace", async () => {
    const workspaceRoot = await makeTempDir();
    const projectRoot = path.join(workspaceRoot, "apps", "todo");
    const packageRoot = path.join(workspaceRoot, "node_modules", "cf");
    await fs.mkdir(projectRoot, { recursive: true });
    await writeCfPackage(packageRoot);

    await expect(resolveLocalPackage(projectRoot, "cf", "cf")).resolves.toEqual({
      version: "1.0.0-beta.14",
      binPath: await resolvedCfBin(packageRoot),
    });
  });

  it("resolves a package whose exports map omits ./package.json", async () => {
    // drizzle-kit ships exactly this shape, which makes
    // require.resolve("drizzle-kit/package.json") throw
    // ERR_PACKAGE_PATH_NOT_EXPORTED even though the file exists.
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(projectRoot, "node_modules", "drizzle-kit");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "drizzle-kit",
        version: "0.31.11",
        bin: { "drizzle-kit": "bin.cjs" },
        exports: { ".": "./index.js", "./api": "./api.js" },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(packageRoot, "bin.cjs"), "", "utf-8");

    await expect(
      resolveLocalPackage(projectRoot, "drizzle-kit", "drizzle-kit"),
    ).resolves.toEqual({
      version: "0.31.11",
      binPath: await fs.realpath(path.join(packageRoot, "bin.cjs")),
    });
  });

  it("fails actionably when the package is missing from the project layout", async () => {
    const projectRoot = await makeTempDir();
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}", "utf-8");

    await expect(resolveLocalPackage(projectRoot, "cf", "cf")).rejects.toThrow(
      `Could not resolve the project-local "cf" binary from project root "${projectRoot}". Install the project's declared cf dependency and try again.`,
    );
  });
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "everyapp-local-bin-test-"));
}

async function writeCfPackage(packageRoot: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "cf", version: "1.0.0-beta.14", bin: { cf: "bin/cf" } }),
    "utf-8",
  );
  await fs.writeFile(path.join(packageRoot, "bin", "cf"), "", "utf-8");
}

async function resolvedCfBin(packageRoot: string): Promise<string> {
  return fs.realpath(path.join(packageRoot, "bin", "cf"));
}
