import type { LocalContext } from "@/context";
import chalk from "chalk";
import enquirer from "enquirer";
import { copyStarter, newAppDir } from "@/lib/app/starter";
import { checkoutRoot, isInCheckout } from "@/lib/checkout";
import { directoryExists } from "@/lib/file-operations";
import { initRepository } from "@/lib/git";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkNotNestedApp } from "@/commands/app/create/steps/checkNotNestedApp";
import { checkPnpm } from "@/commands/app/create/steps/checkPnpm";
import { promptUserInput } from "@/commands/app/create/steps/promptUserInput";
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
 * 5. Copy the starter template from this checkout: to apps/<id> inside the
 *    checkout, or ./<id> anywhere else (lib/app/starter.ts)
 * 6. Deploy (registers with the gateway, creates D1/KV, migrates, uploads)
 * 7. Create .env.local
 * 8. Run local migrations
 * 9. Outside the checkout, start a git repository for it
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
  const root = checkoutRoot();
  const targetDir = newAppDir({ appId, cwd: process.cwd(), root });
  if (await directoryExists(targetDir)) {
    console.error(chalk.red(`\n${targetDir} already exists.\n`));
    setExitCode(1);
    return;
  }

  // Confirm deployment BEFORE copying to avoid leaving project in weird state
  if (!skipConfirmation && canPromptInTerminal(false)) {
    const { confirmed } = await enquirer.prompt<{ confirmed: boolean }>({
      type: "confirm",
      name: "confirmed",
      message: `Create ${appId} in ${targetDir} and deploy it to ${gatewayUrl}?`,
      initial: false,
    });
    if (!confirmed) {
      console.log(chalk.yellow("\nApp creation cancelled.\n"));
      return;
    }
  }

  try {
    await copyStarter({ root, targetDir, appId });
    if (verbose) console.log(chalk.dim(`  Template copied to ${targetDir}\n`));

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

    // Its own git repository, unless it's part of this checkout's
    if (!isInCheckout(targetDir, root)) {
      await initRepository({ targetDir, verbose });
    }

    printNextSteps({ targetDir, gatewayUrl, liveUrl });
  } catch (error) {
    console.error(chalk.red("\nFailed to create project."));
    reportFailure(createHumanSink(), error);
    setExitCode(1);
  }
}
