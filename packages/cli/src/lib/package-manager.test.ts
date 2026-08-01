import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectPackageManager } from "./package-manager";

describe("detectPackageManager", () => {
  it("uses packageManager before lockfiles", async () => {
    const cwd = await makeTempDir();
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.9.2" }),
      "utf-8",
    );
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "", "utf-8");

    await expect(detectPackageManager(cwd)).resolves.toBe("yarn");
  });

  it("detects pnpm, yarn, and npm lockfiles", async () => {
    await expect(detectWithFile("pnpm-lock.yaml")).resolves.toBe("pnpm");
    await expect(detectWithFile("yarn.lock")).resolves.toBe("yarn");
    await expect(detectWithFile("package-lock.json")).resolves.toBe("npm");
  });

  it("falls back to pnpm when no package manager signal exists", async () => {
    await expect(detectPackageManager(await makeTempDir())).resolves.toBe("pnpm");
  });
});

async function detectWithFile(filename: string): Promise<string> {
  const cwd = await makeTempDir();
  await fs.writeFile(path.join(cwd, filename), "", "utf-8");
  return detectPackageManager(cwd);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "everyapp-pm-test-"));
}
