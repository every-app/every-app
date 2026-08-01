import chalk from "chalk";
import { runLocalAppMigrations } from "@/lib/migrations";
import type { EveryAppManifest } from "@every-app/perimeter/manifest";

interface ApplyDevMigrationsOptions {
  cwd: string;
  manifest: EveryAppManifest;
  configPath: string;
  skipMigrations: boolean;
}

export async function applyDevMigrations({
  cwd,
  manifest,
  configPath,
  skipMigrations,
}: ApplyDevMigrationsOptions): Promise<boolean> {
  if (skipMigrations) {
    return true;
  }

  try {
    await runLocalAppMigrations({
      cwd,
      d1Bindings: manifest.resources?.d1 ?? [],
      migrations: manifest.migrations,
      configPath,
    });
    return true;
  } catch (error) {
    console.error(
      chalk.red(
        `Failed to apply local database migrations: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    // Every template and example app ships this script, and the troubleshooting
    // docs point at it. Printing our internal command construction instead would
    // leak the sqlite-bootstrap workaround and drift from the real recipe.
    console.error("Run manually: pnpm run db:migrate:local");
    console.error(
      chalk.dim(
        "Fix the migration error, then start dev again. Use --skip-migrations only if the local database is already usable.",
      ),
    );
    process.exitCode = 1;
    return false;
  }
}
