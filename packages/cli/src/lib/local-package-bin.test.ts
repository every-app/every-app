import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocalPackageBin } from "./local-package-bin";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");

afterEach(() => {
  mocks.execFileSync.mockReset();
  if (bunDescriptor) {
    Object.defineProperty(process.versions, "bun", bunDescriptor);
  } else {
    delete process.versions["bun"];
  }
});

describe("resolveLocalPackageBin", () => {
  it("resolves a package binary from the project node_modules", async () => {
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(projectRoot, "node_modules", "wrangler");
    await writeWranglerPackage(packageRoot);

    await expect(
      resolveLocalPackageBin(projectRoot, "wrangler", "wrangler"),
    ).resolves.toEqual({
      command: process.execPath,
      argsPrefix: [await resolvedWranglerBin(packageRoot)],
    });
  });

  it("resolves through a pnpm-style package symlink", async () => {
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(
      projectRoot,
      "node_modules",
      ".pnpm",
      "wrangler@4.111.0",
      "node_modules",
      "wrangler",
    );
    await writeWranglerPackage(packageRoot);
    const packageLink = path.join(projectRoot, "node_modules", "wrangler");
    await fs.symlink(
      path.relative(path.dirname(packageLink), packageRoot),
      packageLink,
      "dir",
    );

    await expect(
      resolveLocalPackageBin(projectRoot, "wrangler", "wrangler"),
    ).resolves.toEqual({
      command: process.execPath,
      argsPrefix: [await resolvedWranglerBin(packageRoot)],
    });
  });

  it("resolves a hoisted package from a nested project", async () => {
    const workspaceRoot = await makeTempDir();
    const projectRoot = path.join(workspaceRoot, "packages", "app");
    const packageRoot = path.join(workspaceRoot, "node_modules", "wrangler");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}", "utf-8");
    await writeWranglerPackage(packageRoot);

    await expect(
      resolveLocalPackageBin(projectRoot, "wrangler", "wrangler"),
    ).resolves.toEqual({
      command: process.execPath,
      argsPrefix: [await resolvedWranglerBin(packageRoot)],
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
        bin: { "drizzle-kit": "bin.cjs" },
        exports: { ".": "./index.js", "./api": "./api.js" },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(packageRoot, "bin.cjs"), "", "utf-8");

    await expect(
      resolveLocalPackageBin(projectRoot, "drizzle-kit", "drizzle-kit"),
    ).resolves.toEqual({
      command: process.execPath,
      argsPrefix: [await fs.realpath(path.join(packageRoot, "bin.cjs"))],
    });
  });

  it("fails actionably when Wrangler is missing from the project layout", async () => {
    const projectRoot = await makeTempDir();
    await fs.writeFile(path.join(projectRoot, "package.json"), "{}", "utf-8");

    await expect(
      resolveLocalPackageBin(projectRoot, "wrangler", "wrangler"),
    ).rejects.toThrow(
      `Could not resolve the project-local "wrangler" binary from project root "${projectRoot}". Install the project's declared wrangler dependency and try again.`,
    );
  });

  it("uses Node from PATH when the CLI is running under Bun", async () => {
    Object.defineProperty(process.versions, "bun", {
      configurable: true,
      value: "1.2.0",
    });
    mocks.execFileSync.mockReturnValue(Buffer.from("v22.0.0"));
    const projectRoot = await makeTempDir();
    const packageRoot = path.join(projectRoot, "node_modules", "wrangler");
    await writeWranglerPackage(packageRoot);

    await expect(
      resolveLocalPackageBin(projectRoot, "wrangler", "wrangler"),
    ).resolves.toEqual({
      command: "node",
      argsPrefix: [await resolvedWranglerBin(packageRoot)],
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith("node", ["--version"], {
      stdio: "ignore",
    });
  });

  it("fails clearly under Bun when Node is unavailable", async () => {
    Object.defineProperty(process.versions, "bun", {
      configurable: true,
      value: "1.2.0",
    });
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });

    await expect(
      resolveLocalPackageBin(".", "wrangler", "wrangler"),
    ).rejects.toThrow(
      "Every App CLI must run project binaries under Node.js because Wrangler deploys silently no-op under Bun.",
    );
  });
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "everyapp-local-bin-test-"));
}

async function writeWranglerPackage(packageRoot: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "wrangler", bin: { wrangler: "bin/wrangler.js" } }),
    "utf-8",
  );
  await fs.writeFile(path.join(packageRoot, "bin", "wrangler.js"), "", "utf-8");
}

async function resolvedWranglerBin(packageRoot: string): Promise<string> {
  return fs.realpath(path.join(packageRoot, "bin", "wrangler.js"));
}
