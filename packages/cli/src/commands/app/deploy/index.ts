import type { LocalContext } from "@/context";
import chalk from "chalk";
import { getAppId } from "@/lib/everyapp-config";
import { confirmDeployment } from "@/lib/deployment";
import { deployApp } from "@/commands/app/deploy/deployApp";

interface DeployCommandFlags {
  verbose?: boolean;
}

/**
 * Main deploy command implementation
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  const cwd = process.cwd();
  const verbose = flags.verbose || false;

  // Get appId from every-app.jsonc (required)
  const appId = await getAppId(cwd);

  console.log(chalk.bold(`\nProject: ${appId}\n`));

  const confirmed = await confirmDeployment(
    "Do you want to deploy this app to Cloudflare?",
  );
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
