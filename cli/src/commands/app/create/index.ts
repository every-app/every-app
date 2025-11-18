import type { LocalContext } from "@/context";
import chalk from "chalk";
import { installDependencies } from "@/lib/package-manager";
import { cleanupTempDirectory } from "@/lib/file-operations";
import { getWorkerUrl } from "@/lib/cloudflare-auth";
import { checkPnpm } from "@/commands/app/create/steps/checkPnpm";
import { promptUserInput } from "@/commands/app/create/steps/promptUserInput";
import { cloneTemplate } from "@/commands/app/create/steps/cloneTemplate";
import { setupCloudflareResources } from "@/commands/app/create/steps/setupCloudflareResources";
import { updateConfiguration } from "@/commands/app/create/steps/updateConfiguration";
import { runLocalMigrations } from "@/commands/app/create/steps/runLocalMigrations";
import { printNextSteps } from "@/commands/app/create/steps/printNextSteps";

interface CreateCommandFlags {
  verbose?: boolean;
}

/**
 * Main create command implementation
 */
export default async function (
  this: LocalContext,
  flags: CreateCommandFlags,
): Promise<void> {
  const verbose = flags.verbose || false;

  await checkPnpm();

  console.log("\nCreate a new Every App project\n");

  let tempDir: string | null = null;

  try {
    const { appId } = await promptUserInput();

    const { tempDir: clonedTempDir, targetDir } = await cloneTemplate(
      appId,
      verbose,
    );
    tempDir = clonedTempDir;

    const { d1DatabaseId, kvNamespaceId } = await setupCloudflareResources(
      appId,
      verbose,
    );

    await updateConfiguration(
      targetDir,
      appId,
      d1DatabaseId,
      kvNamespaceId,
      verbose,
    );

    console.log();
    await installDependencies(
      targetDir,
      "Installing dependencies for local dev...",
      verbose,
    );

    const [, gatewayUrl] = await Promise.all([
      runLocalMigrations(targetDir, verbose),
      getWorkerUrl("every-app-gateway"),
    ]);

    printNextSteps(appId, targetDir, gatewayUrl);
  } catch (error) {
    console.error(
      chalk.red("\nFailed to create project:"),
      error instanceof Error ? error.message : "Unknown error",
    );
    throw error;
  } finally {
    if (tempDir) {
      await cleanupTempDirectory(tempDir);
    }
  }
}
