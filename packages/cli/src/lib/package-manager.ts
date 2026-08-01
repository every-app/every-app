import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { execa } from "execa";
import { executeCommandWithFormatting } from "./formatting";

/**
 * Check if pnpm is installed
 */
async function isPnpmInstalled(): Promise<boolean> {
  try {
    await execa("pnpm", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface InstallDependenciesOptions {
  cwd: string;
  description: string;
  install?: string | false;
  verbose?: boolean;
}

type PackageManager = "pnpm" | "yarn" | "npm";

interface InstallCommand {
  command: string;
  args: string[];
}

/**
 * Install dependencies using pnpm (either directly or via npx)
 */
export async function installDependencies({
  cwd,
  description,
  install,
  verbose = false,
}: InstallDependenciesOptions): Promise<void> {
  if (install === false) {
    console.log(chalk.dim("  Skipping dependency install (manifest install=false)."));
    return;
  }

  if (typeof install === "string") {
    await executeCommandWithFormatting(install, [], {
      cwd,
      verbose,
      description,
      shell: true,
    });
    return;
  }

  const packageManager = await detectPackageManager(cwd);
  const { command, args } = await getInstallCommand(packageManager);

  // NOTE: pnpm >=10 blocks dependency build scripts unless approved, and
  // pnpm 11 exits 1 (ERR_PNPM_IGNORED_BUILDS) — fatal here since nobody can
  // answer `pnpm approve-builds` in this non-interactive install. Projects we
  // install must declare their approvals (the gateway release ships an
  // `allowBuilds` allowlist in its pnpm-workspace.yaml; see build-release.js).
  try {
    await executeCommandWithFormatting(command, args, {
      cwd,
      verbose,
      description,
    });
  } catch (error) {
    throw new Error(
      `Failed to install dependencies with ${packageManager}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const fromPackageManager = await detectPackageManagerField(cwd);
  if (fromPackageManager) return fromPackageManager;

  if (await fileExists(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExists(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExists(path.join(cwd, "package-lock.json"))) return "npm";

  return "pnpm";
}

async function detectPackageManagerField(
  cwd: string,
): Promise<PackageManager | null> {
  const packageJsonPath = path.join(cwd, "package.json");
  try {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));
    const packageManager = packageJson.packageManager;
    if (typeof packageManager !== "string") return null;
    if (packageManager.startsWith("pnpm")) return "pnpm";
    if (packageManager.startsWith("yarn")) return "yarn";
    if (packageManager.startsWith("npm")) return "npm";
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function getInstallCommand(
  packageManager: PackageManager,
): Promise<InstallCommand> {
  if (packageManager === "yarn") return { command: "yarn", args: ["install"] };
  if (packageManager === "npm") return { command: "npm", args: ["install"] };

  if (await isPnpmInstalled()) {
    return { command: "pnpm", args: ["install"] };
  }
  return { command: "npx", args: ["pnpm", "install"] };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
