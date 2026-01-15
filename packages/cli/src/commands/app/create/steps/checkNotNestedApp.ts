import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";

const CONFIG_FILES = ["every-app.jsonc", "every-app.json"];

/**
 * Check if we're already inside an Every App project directory.
 * If an every-app.jsonc or every-app.json file exists in the current directory,
 * exit with an error to prevent creating nested projects.
 */
export async function checkNotNestedApp(): Promise<void> {
  const cwd = process.cwd();

  for (const configFile of CONFIG_FILES) {
    const configPath = path.join(cwd, configFile);
    try {
      await fs.access(configPath);
      // File exists - this is an existing Every App project
      console.log(chalk.yellow("\nAlready inside an Every App project"));
      console.log(chalk.dim(`  Found ${configFile}\n`));
      console.log(
        "To create a new app, run app create from the directory where you store your projects.\n",
      );
      console.log("If you meant to deploy this app, run:");
      console.log(chalk.dim("  npx everyapp app deploy\n"));
      process.exit(1);
    } catch {
      // File doesn't exist, continue checking
    }
  }
}
