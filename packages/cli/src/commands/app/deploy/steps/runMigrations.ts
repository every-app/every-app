import chalk from "chalk";
import { runWithRemoteD1 } from "@/lib/remote-d1";

interface RunMigrationsOptions {
  cwd: string;
  verbose?: boolean;
}

/**
 * Run database migrations for the app
 */
export async function runMigrations({
  cwd,
  verbose = false,
}: RunMigrationsOptions): Promise<void> {
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
