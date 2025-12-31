import chalk from "chalk";
import { runWithRemoteD1 } from "@/lib/remote-d1";
import type { WranglerConfig } from "@/lib/wrangler-config";

/**
 * Run database migrations for the app
 */
export async function runMigrations(
  cwd: string,
  config: WranglerConfig,
  verbose: boolean = false,
): Promise<void> {
  if (!config.d1_databases || config.d1_databases.length === 0) {
    if (verbose) {
      console.log(
        chalk.dim("No D1 databases configured, skipping migrations\n"),
      );
    }
    return;
  }

  try {
    console.log();
    console.log(
      chalk.dim(
        "  Running any pending migrations against your remote D1 Database...",
      ),
    );

    await runWithRemoteD1(
      "npx",
      ["drizzle-kit", "migrate", "--config=drizzle-prod.config.ts"],
      {
        cwd,
        verbose,
      },
    );

    console.log(chalk.green("\nMigrations completed!\n"));
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Failed to run migrations. You may need to run them manually:\n` +
          `  npx drizzle-kit migrate --config=drizzle-prod.config.ts\n`,
      ),
    );
    // Don't throw - continue with deployment
  }
}
