import type { LocalContext } from "@/context";
import chalk from "chalk";
import { cleanupTempDirectory, createEnvFiles } from "@/lib/file-operations";
import { confirmDeployment } from "@/lib/deployment";
import { writeEveryAppConfig } from "@/lib/everyapp-config";
import { checkPnpm } from "@/commands/app/create/steps/checkPnpm";
import { promptUserInput } from "@/commands/app/create/steps/promptUserInput";
import { cloneTemplate } from "@/commands/app/create/steps/cloneTemplate";
import { updatePackageJson } from "@/commands/app/create/steps/updateConfiguration";
import { runLocalMigrations } from "@/commands/app/create/steps/runLocalMigrations";
import { printNextSteps } from "@/commands/app/create/steps/printNextSteps";
import { deployApp } from "@/commands/app/deploy/deployApp";

interface CreateCommandFlags {
  verbose?: boolean;
}

/**
 * Main create command implementation
 *
 * Flow:
 * 1. Check pnpm installed
 * 2. Prompt for app ID (with optional default from CLI argument)
 * 3. Confirm deployment to Cloudflare account (before any file operations)
 * 4. Clone template
 * 5. Update package.json with app name
 * 6. Deploy to Cloudflare (creates D1/KV, runs migrations, deploys worker)
 * 7. Create .env.local
 * 8. Run local migrations
 * 9. Print success message
 */
export default async function (
  this: LocalContext,
  flags: CreateCommandFlags,
  nameArg?: string,
): Promise<void> {
  const verbose = flags.verbose || false;

  await checkPnpm();

  console.log("\nCreate a new Every App project\n");

  const { appId } = await promptUserInput(nameArg);

  // Confirm deployment BEFORE cloning to avoid leaving project in weird state
  console.log(chalk.dim(".\n"));
  const confirmed = await confirmDeployment(
    "Deploy this app to the above account? We deploy during app creation for smoother local dev with Cloudflare.",
  );
  if (!confirmed) {
    console.log(chalk.yellow("\nApp creation cancelled.\n"));
    return;
  }

  let tempDir: string | null = null;

  try {
    const { tempDir: clonedTempDir, targetDir } = await cloneTemplate(
      appId,
      verbose,
    );
    tempDir = clonedTempDir;

    // Update package.json with app name before deployment
    await updatePackageJson(targetDir, appId);

    // Write every-app.jsonc with the canonical appId
    await writeEveryAppConfig(targetDir, { appId });

    // Deploy to Cloudflare (creates D1/KV, installs deps, runs prod migrations, deploys)
    const { workerUrl, gatewayUrl } = await deployApp({
      cwd: targetDir,
      appId,
      verbose,
      devUrl: "http://localhost:3001",
    });

    // Local setup: create .env.local and run local migrations
    await createEnvFiles(targetDir, appId);
    await runLocalMigrations(targetDir, verbose);

    printNextSteps(appId, targetDir, gatewayUrl, workerUrl);
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
