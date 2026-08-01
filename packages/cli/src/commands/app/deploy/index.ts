import type { LocalContext } from "@/context";
import chalk from "chalk";
import { confirmDeployment } from "@/lib/deployment";
import { requireCloudflareAuth } from "@/lib/cloudflare";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
import { deployApp } from "@/commands/app/deploy/deployApp";
import { loadEveryAppManifest } from "@/lib/generateWranglerConfig";

interface DeployCommandFlags {
  verbose?: boolean;
  yes?: boolean;
  "skip-dns-check"?: boolean;
  domain?: string;
}

/**
 * Main deploy command implementation
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  if (flags.domain !== undefined) {
    throw new Error(
      "apps derive their address from the gateway's domain automatically; configure the domain with `everyapp gateway deploy --domain <apex-domain>`.",
    );
  }

  await requireCloudflareAuth();

  // Check gateway is deployed and has an owner account before proceeding
  await requireGatewaySetup();

  const cwd = process.cwd();
  const verbose = flags.verbose || false;
  const skipConfirmation = flags.yes || false;
  const skipDnsCheck = flags["skip-dns-check"] || false;

  // Check we're inside an Every App project
  await checkIsEveryAppProject();

  const manifest = await loadEveryAppManifest(cwd);
  const appId = manifest.id;

  console.log(chalk.bold(`\nProject: ${appId}\n`));

  const confirmed = await confirmDeployment("this app", skipConfirmation);
  if (!confirmed) {
    console.log(chalk.red("\nDeployment cancelled by user\n"));
    return;
  }

  const { liveUrl, gatewayUrl } = await deployApp({
    cwd,
    manifest,
    verbose,
    skipDnsCheck,
  });

  console.log(chalk.green("\nDeployment successful!"));
  console.log(`  App live at: ${chalk.cyan(liveUrl)}`);
  console.log(
    chalk.dim("  Gateway routes this app through a service binding."),
  );
  console.log(`  Gateway: ${chalk.cyan(gatewayUrl)}\n`);
}
