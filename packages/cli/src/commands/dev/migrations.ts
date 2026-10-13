import chalk from "chalk";
import { applyLocalMigrations, legacyLocalStateNote } from "@/lib/app/localD1";
import type { CfRunner } from "@/lib/cf/runner";
import { setExitCode } from "@/lib/exit-code";
import type { EveryAppCliManifest } from "@/lib/manifest";

interface ApplyDevMigrationsOptions {
  cwd: string;
  manifest: EveryAppCliManifest;
  cf: CfRunner;
  skipMigrations: boolean;
}

export async function applyDevMigrations({
  cwd,
  manifest,
  cf,
  skipMigrations,
}: ApplyDevMigrationsOptions): Promise<boolean> {
  if (skipMigrations) {
    return true;
  }

  try {
    const note = await legacyLocalStateNote(cwd);
    if (note) console.log(chalk.dim(`  ${note}`));
    console.log(chalk.dim("  Applying local database migrations..."));
    const result = await applyLocalMigrations({ cwd, manifest, cf });
    if (result.status === "applied") {
      console.log(
        chalk.dim(
          result.applied.length > 0
            ? `  Applied ${result.applied.join(", ")}.`
            : "  Local database is up to date.",
        ),
      );
    }
    return true;
  } catch (error) {
    console.error(
      chalk.red(
        `Failed to apply local database migrations: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    // Every template and example app ships this script, and the troubleshooting
    // docs point at it, so it's the recipe to print rather than the raw cf call.
    console.error("Run manually: pnpm run db:migrate:local");
    console.error(
      chalk.dim(
        "Fix the migration error, then start dev again. Use --skip-migrations only if the local database is already usable.",
      ),
    );
    setExitCode(1);
    return false;
  }
}
