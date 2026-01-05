import chalk from "chalk";
import { executeCommandWithFormatting } from "@/lib/formatting";

interface RunLocalMigrationsOptions {
  targetDir: string;
  verbose?: boolean;
}

/**
 * Run database migrations locally
 */
export async function runLocalMigrations({
  targetDir,
  verbose = false,
}: RunLocalMigrationsOptions): Promise<void> {
  try {
    if (!verbose) {
      console.log("\nSetting up Cloudflare for local dev...");
    }

    await executeCommandWithFormatting("pnpm", ["run", "cf-typegen"], {
      cwd: targetDir,
      verbose,
      logCommandToConsole: false,
    });

    await executeCommandWithFormatting("pnpm", ["run", "build"], {
      cwd: targetDir,
      verbose,
      logCommandToConsole: false,
    });

    if (!verbose) console.log(chalk.dim("  Finished.\n"));

    await executeCommandWithFormatting("pnpm", ["run", "db:migrate:local"], {
      cwd: targetDir,
      verbose,
    });

    console.log("\nLocal database migrations complete.\n");
  } catch (error) {
    console.warn(
      chalk.yellow(
        "\nFailed to run local migrations. You can run them manually with:",
      ),
    );
    console.warn(chalk.dim("   pnpm run db:migrate:local\n"));
  }
}
