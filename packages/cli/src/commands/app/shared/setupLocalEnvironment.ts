import chalk from "chalk";
import { createEnvFiles } from "@/lib/file-operations";
import { installDependencies } from "@/lib/package-manager";
import { runLocalMigrations } from "@/commands/app/create/steps/runLocalMigrations";
import type { EveryAppManifest } from "@every-app/perimeter/manifest";

interface SetupLocalEnvironmentOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  gatewayUrl?: string;
  verbose?: boolean;
  installDeps?: boolean;
  migrations?: EveryAppManifest["migrations"];
}

/**
 * Shared local environment setup used by both `app create` and `app setup-local`.
 */
export async function setupLocalEnvironment({
  targetDir,
  appId,
  gatewayUrl,
  verbose = false,
  installDeps = false,
  migrations,
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
    appId,
    gatewayUrl,
  });
  if (migrations?.engine === "d1-sql") {
    console.log(
      chalk.dim(
        "Skipping local migration scripts for d1-sql app; manage local D1 state with Wrangler migrations.",
      ),
    );
    return;
  }
  await runLocalMigrations({ targetDir, verbose });
}
