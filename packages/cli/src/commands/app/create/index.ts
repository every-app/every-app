import type { LocalContext } from "@/context";
import chalk from "chalk";
import enquirer from "enquirer";
import { cleanupTempDirectory } from "@/lib/file-operations";
import { initRepository } from "@/lib/git";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkNotNestedApp } from "@/commands/app/create/steps/checkNotNestedApp";
import { checkPnpm } from "@/commands/app/create/steps/checkPnpm";
import { promptUserInput } from "@/commands/app/create/steps/promptUserInput";
import { cloneTemplate } from "@/commands/app/create/steps/cloneTemplate";
import {
  updateEveryappManifestId,
  updatePackageJson,
} from "@/commands/app/create/steps/updateConfiguration";
import { setupLocalEnvironment } from "@/commands/app/shared/setupLocalEnvironment";
import { printNextSteps } from "@/commands/app/create/steps/printNextSteps";
import { loadEveryAppManifest } from "@/lib/manifest";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { canPromptInTerminal } from "@/lib/cf/deploy";
import { createHumanSink } from "@/lib/output/events";
import { reportFailure } from "@/lib/output/report";
import { setExitCode } from "@/lib/exit-code";

interface CreateCommandFlags {
  gateway?: string;
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
 * 4. Confirm the deploy to the gateway (before any file operations)
 * 5. Clone template
 * 6. Update package.json with app name
 * 7. Deploy (registers with the gateway, creates D1/KV, migrates, uploads)
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

  // Check gateway is deployed and has an owner account before proceeding
  const gatewayUrl = await requireGatewaySetup(flags.gateway);

  console.log("\nCreate a new Every App project\n");

  const { appId } = await promptUserInput(nameArg);

  // Confirm deployment BEFORE cloning to avoid leaving project in weird state
  if (!skipConfirmation && canPromptInTerminal(false)) {
    const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message: `Create ${appId} and deploy it to ${gatewayUrl}?`,
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.yellow("\nApp creation cancelled.\n"));
      return;
    }
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
    await updateEveryappManifestId({ targetDir, appId });

    // Deploy (registers it, creates D1/KV, installs deps, migrates, uploads)
    const { liveUrl } = await deployApp({
      cwd: targetDir,
      gatewayUrl,
      out: createHumanSink(),
      verbose,
    });

    // Local setup: create .env.local, generate types, migrate local D1
    await setupLocalEnvironment({
      targetDir,
      manifest: await loadEveryAppManifest(targetDir),
      verbose,
      gatewayUrl,
    });

    // Initialize git repository with initial commit
    await initRepository({ targetDir, verbose });

    printNextSteps({ appId, targetDir, gatewayUrl, liveUrl });
  } catch (error) {
    console.error(chalk.red("\nFailed to create project."));
    reportFailure(createHumanSink(), error);
    setExitCode(1);
  } finally {
    if (tempDir) {
      await cleanupTempDirectory({ tmpDir: tempDir });
    }
  }
}
