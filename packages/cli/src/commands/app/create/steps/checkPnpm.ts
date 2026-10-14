import chalk from "chalk";
import { execa } from "execa";

/**
 * Check if pnpm is installed and exit if not
 */
export async function checkPnpm(): Promise<void> {
  try {
    await execa("pnpm", ["--version"], { stdio: "pipe" });
  } catch {
    console.error(
      chalk.red(
        "\nError: pnpm is required but not installed. Please install it first:",
      ),
    );
    console.error(chalk.cyan("  npm i -g pnpm\n"));
    process.exit(1);
  }
}
