import chalk from "chalk";
import { runWithRemoteD1 } from "@/lib/remote-d1";
import { verboseLogLines } from "@/lib/logging";

const MIGRATION_COMMAND = "npx";
const MIGRATION_ARGS = [
  "drizzle-kit",
  "migrate",
  "--config=drizzle-prod.config.ts",
];

interface RunDrizzleMigrationsOptions {
  /** Working directory containing drizzle config */
  cwd: string;
  /** Whether to show command output */
  verbose?: boolean;
}

/**
 * Run drizzle-kit migrations against a remote D1 database.
 * Throws on failure - callers should handle errors appropriately.
 */
export async function runDrizzleMigrations({
  cwd,
  verbose = false,
}: RunDrizzleMigrationsOptions): Promise<void> {
  console.log(`\nRunning: ${MIGRATION_COMMAND} ${MIGRATION_ARGS.join(" ")}`);
  console.log(chalk.dim("  Running database migrations..."));

  verboseLogLines(
    verbose,
    "  Running any pending migrations against your remote D1 Database...",
  );

  await runWithRemoteD1(MIGRATION_COMMAND, MIGRATION_ARGS, {
    cwd,
    verbose,
  });

  console.log(chalk.dim("  Migrations completed.\n"));
}
