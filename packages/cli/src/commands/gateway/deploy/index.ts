import type { LocalContext } from "@/context";
import chalk from "chalk";
import path from "node:path";
import { setupCloudflareResources } from "@/commands/gateway/deploy/steps/setupCloudflareResources";
import { updateConfigAndDeploy } from "@/commands/gateway/deploy/steps/updateConfigAndDeploy";
import { runMigrations } from "@/commands/gateway/deploy/steps/runMigrations";
import type { DeployCommandFlags } from "@/commands/gateway/deploy/types";
import {
  cleanupTempDirectory,
  createTempDirectory,
} from "@/lib/file-operations";
import { getWorkerName } from "@/lib/wrangler-config";
import { confirmDeployment, ensureWorkersDevSubdomain } from "@/lib/deployment";
import { getWorkerUrl, requireCloudflareAuth } from "@/lib/cloudflare";
import { downloadLatestGatewayRelease } from "@/lib/github-releases";

export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  await requireCloudflareAuth();

  const verbose = flags.verbose || false;

  const confirmed = await confirmDeployment(
    "Do you want to deploy EveryApp Gateway into this Cloudflare account?",
  );
  if (!confirmed) {
    console.log("\nDeployment cancelled by user\n");
    return;
  }

  // If they've never deployed a worker before, they'll need to choose a subdomain.
  await ensureWorkersDevSubdomain();

  const resources = await setupCloudflareResources({ verbose });

  // Download prebuilt release
  const tmpDir = await createTempDirectory("gateway-deploy-");
  if (verbose) {
    console.log(chalk.dim(`Working directory: ${tmpDir}\n`));
  }

  let workerUrl = null;
  try {
    const gatewayPath = await downloadLatestGatewayRelease(tmpDir, verbose);

    // Predict worker URL
    const wranglerConfigPath = path.join(gatewayPath, "wrangler.jsonc");
    const workerName = await getWorkerName(wranglerConfigPath);
    workerUrl = await getWorkerUrl(workerName);

    // Update config and deploy (secrets are set inside this function after vars are removed)
    await updateConfigAndDeploy({ gatewayPath, resources, workerUrl, verbose });

    // Run database migrations
    await runMigrations({ gatewayPath, verbose });
  } catch (error) {
    console.error(
      "\nDeployment failed:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  } finally {
    await cleanupTempDirectory({ tmpDir, verbose });
  }

  if (!workerUrl)
    throw new Error("Worker URL not set properly during deployment");

  console.log(chalk.green("\nGateway deployment successful!\n"));
  console.log(`Your Gateway is now live at: ${chalk.cyan(workerUrl)}\n`);
}
