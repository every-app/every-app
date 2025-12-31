import type { LocalContext } from "@/context";
import chalk from "chalk";
import { readWranglerConfig } from "@/lib/wrangler-config";
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

  const config = await readWranglerConfig(cwd);

  if (!config.name) {
    throw new Error(
      "Worker name not found in wrangler.jsonc. Please add a 'name' field.",
    );
  }

  const workerName = config.name;
  console.log(chalk.bold(`\nProject name: ${workerName}\n`));

  const confirmed = await confirmDeployment(
    "Do you want to deploy this app to Cloudflare?",
  );
  if (!confirmed) {
    console.log(chalk.red("\nDeployment cancelled by user\n"));
    return;
  }

  const { workerUrl, gatewayUrl } = await deployApp({
    cwd,
    workerName,
    verbose,
    config,
  });

  console.log(chalk.green("\nDeployment successful!"));
  console.log(chalk.dim(`  App URL: ${chalk.cyan(workerUrl)}`));
  console.log(`  Gateway: ${chalk.cyan(gatewayUrl)}\n`);
}
