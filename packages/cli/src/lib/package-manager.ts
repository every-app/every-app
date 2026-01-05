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
  verbose?: boolean;
}

/**
 * Install dependencies using pnpm (either directly or via npx)
 */
export async function installDependencies({
  cwd,
  description,
  verbose = false,
}: InstallDependenciesOptions): Promise<void> {
  const hasPnpm = await isPnpmInstalled();

  try {
    if (hasPnpm) {
      // Use pnpm directly if installed
      await executeCommandWithFormatting("pnpm", ["install"], {
        cwd,
        verbose,
        description,
      });
    } else {
      // Use npx pnpm if pnpm is not installed globally
      await executeCommandWithFormatting("npx", ["pnpm", "install"], {
        cwd,
        verbose,
        description,
      });
    }
  } catch (error) {
    throw new Error(
      `Failed to install dependencies with pnpm: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
