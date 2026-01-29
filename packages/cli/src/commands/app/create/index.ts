import type { LocalContext } from "@/context";
import chalk from "chalk";
import { cleanupTempDirectory, createEnvFiles } from "@/lib/file-operations";
import { confirmDeployment } from "@/lib/deployment";
import { writeEveryAppConfig } from "@/lib/everyapp-config";
import { initRepository } from "@/lib/git";
import { requireCloudflareAuth } from "@/lib/cloudflare";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkNotNestedApp } from "@/commands/app/create/steps/checkNotNestedApp";
import { checkPnpm } from "@/commands/app/create/steps/checkPnpm";
import { promptUserInput } from "@/commands/app/create/steps/promptUserInput";
import { cloneTemplate } from "@/commands/app/create/steps/cloneTemplate";
import { updatePackageJson } from "@/commands/app/create/steps/updateConfiguration";
import { runLocalMigrations } from "@/commands/app/create/steps/runLocalMigrations";
import { printNextSteps } from "@/commands/app/create/steps/printNextSteps";
import { deployApp } from "@/commands/app/deploy/deployApp";

interface CreateCommandFlags {
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Main create command implementation
 *
 * Flow:
 * 1. Check not inside existing Every App project
 * 2. Check pnpm installed
 * 3. Prompt for app ID (with optional default from CLI argument)
 * 4. Confirm deployment to Cloudflare account (before any file operations)
 * 5. Clone template
 * 6. Update package.json with app name
 * 7. Deploy to Cloudflare (creates D1/KV, runs migrations, deploys worker)
 * 8. Create .env.local
 * 9. Run local migrations
 * 10. Print success message
 */
export default async function (
  this: LocalContext,
  flags: CreateCommandFlags,
  nameArg?: string,
): Promise<void> {
  const verbose = flags.verbose || false;
  const skipConfirmation = flags.yes || false;

  // Check we're not inside an existing Every App project
  await checkNotNestedApp();

  await checkPnpm();
  await requireCloudflareAuth();

  // Check gateway is deployed and has an owner account before proceeding
  await requireGatewaySetup();

  console.log("\nCreate a new Every App project\n");

  const { appId } = await promptUserInput(nameArg);

  // Confirm deployment BEFORE cloning to avoid leaving project in weird state
  console.log(chalk.dim(".\n"));
  const confirmed = await confirmDeployment("this app", skipConfirmation);
  if (!confirmed) {
    console.log(chalk.yellow("\nApp creation cancelled.\n"));
    return;
  }

  let tempDir: string | null = null;

  try {
    const { tempDir: clonedTempDir, targetDir } = await cloneTemplate({
      appId,
      verbose,
    });
    tempDir = clonedTempDir;

    // Update package.json with app name before deployment
    await updatePackageJson({ targetDir, appId });

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
    await createEnvFiles({ targetDir, appId });
    await runLocalMigrations({ targetDir, verbose });

    // Initialize git repository with initial commit
    await initRepository({ targetDir, verbose });

    printNextSteps({ appId, targetDir, gatewayUrl, workerUrl });
  } catch (error) {
    console.error(
      chalk.red("\nFailed to create project:"),
      error instanceof Error ? error.message : "Unknown error",
    );
    throw error;
  } finally {
    if (tempDir) {
      await cleanupTempDirectory({ tmpDir: tempDir });
    }
  }
}
