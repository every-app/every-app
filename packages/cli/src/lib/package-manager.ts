import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { runLogged } from "./childLog";
import { isNotFoundError } from "./file-operations";

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
  /** What the install is for, as a failure names it: "Installing dependencies...". */
  description: string;
  install?: string | false;
  /** Stream the install's output to stderr too. */
  verbose?: boolean;
}

export type PackageManager = "pnpm" | "yarn" | "npm";

interface InstallCommand {
  command: string;
  args: string[];
}

/**
 * Install dependencies: the manifest's install command, or the project's
 * package manager (pnpm directly or through npx). Their output goes to a
 * log file (lib/childLog.ts); `install: false` installs nothing.
 */
export async function installDependencies({
  cwd,
  description,
  install,
  verbose = false,
}: InstallDependenciesOptions): Promise<void> {
  if (install === false) return;
  const what = description.replace(/\.+$/, "");

  if (typeof install === "string") {
    await runLogged(install, [], {
      cwd,
      shell: true,
      echo: verbose,
      what,
      code: "INSTALL_FAILED",
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
  await runLogged(command, args, {
    cwd,
    echo: verbose,
    what: `${what} with ${packageManager}`,
    code: "INSTALL_FAILED",
  });
}

export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const fromPackageManager = await detectPackageManagerField(cwd);
  if (fromPackageManager) return fromPackageManager;

  if (await fileExistsStrict(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (await fileExistsStrict(path.join(cwd, "yarn.lock"))) return "yarn";
  if (await fileExistsStrict(path.join(cwd, "package-lock.json"))) return "npm";

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
    if (isNotFoundError(error)) return null;
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

/** Whether `filePath` is there; any error but ENOENT is thrown. */
async function fileExistsStrict(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}
