import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { exitWithUpdateNotice } from "@/lib/version-check";

const CONFIG_FILES = ["everyapp.config.ts"];

/**
 * Check if we're inside an Every App project directory.
 * If no everyapp.config.ts file exists, exit with a helpful message.
 */
export async function checkIsEveryAppProject(): Promise<void> {
  const cwd = process.cwd();

  for (const configFile of CONFIG_FILES) {
    const configPath = path.join(cwd, configFile);
    try {
      await fs.access(configPath);
      // File exists - we're in an Every App project
      return;
    } catch {
      // File doesn't exist, continue checking
    }
  }

  console.log(chalk.yellow("\nNot inside an Every App project"));
  console.log(chalk.dim("  No everyapp.config.ts found\n"));
  console.log(
    "To create a new app, run the below command from the directory where you store your projects:",
  );
  console.log(chalk.dim("  npx everyapp app create\n"));
  await exitWithUpdateNotice(1);
}
