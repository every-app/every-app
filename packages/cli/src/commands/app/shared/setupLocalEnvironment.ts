import chalk from "chalk";
import { createEnvFiles } from "@/lib/file-operations";
import { installDependencies } from "@/lib/package-manager";
import { applyLocalMigrations } from "@/lib/app/localD1";
import { createCfRunner, type CfRunner } from "@/lib/cf/runner";
import type { EveryAppCliManifest } from "@/lib/manifest";

interface SetupLocalEnvironmentOptions {
  targetDir: string;
  manifest: EveryAppCliManifest;
  gatewayUrl: string;
  verbose?: boolean;
  installDeps?: boolean;
  cf?: CfRunner;
}

/**
 * Shared local environment setup used by both `app create` and `app setup-local`.
 */
export async function setupLocalEnvironment({
  targetDir,
  manifest,
  gatewayUrl,
  verbose = false,
  installDeps = false,
  cf = createCfRunner(),
}: SetupLocalEnvironmentOptions): Promise<void> {
  if (installDeps) {
    await installDependencies({
      cwd: targetDir,
      description: "Installing dependencies for local development...",
      verbose,
    });
  }

  await createEnvFiles({
    targetDir,
    appId: manifest.id,
    gatewayUrl,
  });

  try {
    console.log(chalk.dim("Setting up Cloudflare for local dev..."));
    // .cloudflare/types/index.d.ts gives the app its typed Env.
    await cf.run({
      args: ["workers", "types"],
      plane: "project",
      cwd: targetDir,
      mode: "text",
    });
    const result = await applyLocalMigrations({ cwd: targetDir, manifest, cf });
    if (result.status === "applied") {
      console.log(chalk.dim("  Local database migrations complete.\n"));
    }
  } catch (error) {
    if (verbose) {
      console.warn(
        chalk.dim(error instanceof Error ? error.message : String(error)),
      );
    }
    console.warn(
      chalk.yellow(
        "\nFailed to set up the local database. You can run the migrations manually with:",
      ),
    );
    console.warn(chalk.dim("   pnpm run db:migrate:local\n"));
  }
}
