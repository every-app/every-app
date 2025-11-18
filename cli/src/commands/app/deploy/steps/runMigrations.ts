import chalk from "chalk";
import { executeCommandWithFormatting } from "@/lib/formatting";
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
    await executeCommandWithFormatting("npm", ["run", "db:migrate:prod"], {
      cwd,
      description:
        "Running any pending migrations against your remote D1 Database...",
      verbose,
    });

    console.log("\nMigrations completed!\n");
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Failed to run migrations. You may need to run them manually with: npm run db:migrate:prod\n`,
      ),
    );
    // Don't throw - continue with deployment
  }
}
