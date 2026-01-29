import type { LocalContext } from "@/context";
import chalk from "chalk";
import { getAppId } from "@/lib/everyapp-config";
import { confirmDeployment } from "@/lib/deployment";
import { requireCloudflareAuth } from "@/lib/cloudflare";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
import { deployApp } from "@/commands/app/deploy/deployApp";

interface DeployCommandFlags {
  verbose?: boolean;
  yes?: boolean;
}

/**
 * Main deploy command implementation
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  await requireCloudflareAuth();

  // Check gateway is deployed and has an owner account before proceeding
  await requireGatewaySetup();

  const cwd = process.cwd();
  const verbose = flags.verbose || false;
  const skipConfirmation = flags.yes || false;

  // Check we're inside an Every App project
  await checkIsEveryAppProject();

  // Get appId from every-app.jsonc (required)
  const appId = await getAppId(cwd);

  console.log(chalk.bold(`\nProject: ${appId}\n`));

  const confirmed = await confirmDeployment("this app", skipConfirmation);
  if (!confirmed) {
    console.log(chalk.red("\nDeployment cancelled by user\n"));
    return;
  }

  const { workerUrl, gatewayUrl } = await deployApp({
    cwd,
    appId,
    verbose,
  });

  console.log(chalk.green("\nDeployment successful!"));
  console.log(chalk.dim(`  App URL: ${chalk.cyan(workerUrl)}`));
  console.log(`  Gateway: ${chalk.cyan(gatewayUrl)}\n`);
}
