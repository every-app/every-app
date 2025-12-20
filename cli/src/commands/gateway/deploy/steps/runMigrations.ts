import chalk from "chalk";
import { execa } from "execa";
import { runWithRemoteD1 } from "@/lib/remote-d1";
import { readWranglerConfig } from "@/lib/wrangler-config";

/**
 * Run database migrations for the gateway
 */
export async function runMigrations(
  gatewayPath: string,
  verbose: boolean = false,
): Promise<void> {
  const config = await readWranglerConfig(gatewayPath);

  if (!config.d1_databases || config.d1_databases.length === 0) {
    if (verbose) {
      console.log(
        chalk.dim("No D1 databases configured, skipping migrations\n"),
      );
    }
    return;
  }

  console.log(chalk.dim("Running database migrations..."));

  try {
    // Install drizzle-kit locally because drizzle-prod.config.ts imports from 'drizzle-kit'
    // Use --legacy-peer-deps to avoid peer dependency conflicts (e.g., better-auth expects older drizzle-orm)
    await execa("npm", ["install", "--no-save", "--legacy-peer-deps", "drizzle-kit"], {
      cwd: gatewayPath,
      stdio: verbose ? "inherit" : "pipe",
    });

    await runWithRemoteD1(
      "npx",
      ["drizzle-kit", "migrate", "--config=drizzle-prod.config.ts"],
      {
        cwd: gatewayPath,
        verbose,
      },
    );

    console.log(chalk.green("Migrations completed!\n"));
  } catch (error) {
    console.error(error);
  }
}
