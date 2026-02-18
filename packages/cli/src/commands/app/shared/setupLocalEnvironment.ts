import { createEnvFiles } from "@/lib/file-operations";
import { installDependencies } from "@/lib/package-manager";
import { runLocalMigrations } from "@/commands/app/create/steps/runLocalMigrations";

interface SetupLocalEnvironmentOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  gatewayUrl?: string;
  gatewayAppApiToken?: string;
  verbose?: boolean;
  installDeps?: boolean;
}

/**
 * Shared local environment setup used by both `app create` and `app setup-local`.
 */
export async function setupLocalEnvironment({
  targetDir,
  appId,
  gatewayUrl,
  gatewayAppApiToken,
  verbose = false,
  installDeps = false,
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
    gatewayAppApiToken,
  });
  await runLocalMigrations({ targetDir, verbose });
}
