import type { LocalContext } from "@/context";
import chalk from "chalk";
import path from "node:path";
import { setupCloudflareResources } from "@/commands/gateway/deploy/steps/setupCloudflareResources";
import { updateConfigAndDeploy } from "@/commands/gateway/deploy/steps/updateConfigAndDeploy";
import { runDrizzleMigrations } from "@/lib/migrations";
import type { DeployCommandFlags } from "@/commands/gateway/deploy/types";
import {
  cleanupTempDirectory,
  createTempDirectory,
} from "@/lib/file-operations";
import { getWorkerName } from "@/lib/wrangler-config";
import { confirmDeployment, ensureWorkersDevSubdomain } from "@/lib/deployment";
import { getWorkerUrl, requireCloudflareAuth } from "@/lib/cloudflare";
import { exitWithUpdateNotice } from "@/lib/version-check";
import { formatCloudflareError } from "@/lib/cloudflare/errors";
import {
  downloadLatestGatewayRelease,
  extractLocalGatewayTarball,
} from "@/lib/github-releases";
import { checkGatewayHasOwner, checkSslReady } from "@/lib/gateway";
import { waitForSslCertificate } from "@/commands/gateway/deploy/steps/waitForSslCertificate";
import { installDependencies } from "@/lib/package-manager";

export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  await requireCloudflareAuth({ showNewUserHelp: true });

  const verbose = flags.verbose || false;
  const localGateway = flags.localGateway;

  console.log(chalk.bold("\nEvery App Gateway\n"));

  const confirmed = await confirmDeployment("the Gateway");
  if (!confirmed) {
    console.log("\nDeployment cancelled by user\n");
    return;
  }

  // If they've never deployed a worker before, they'll need to choose a subdomain.
  await ensureWorkersDevSubdomain();

  const resources = await setupCloudflareResources({ verbose });

  // Download prebuilt release or use local tarball
  const tmpDir = await createTempDirectory("gateway-deploy-");
  if (verbose) {
    console.log(chalk.dim(`Working directory: ${tmpDir}\n`));
  }

  let workerUrl = null;
  try {
    const gatewayPath = localGateway
      ? await extractLocalGatewayTarball(localGateway, tmpDir, verbose)
      : await downloadLatestGatewayRelease(tmpDir, verbose);

    // Predict worker URL
    const wranglerConfigPath = path.join(gatewayPath, "wrangler.jsonc");
    const workerName = await getWorkerName(wranglerConfigPath);
    workerUrl = await getWorkerUrl(workerName);

    // Update config and deploy (secrets are set inside this function after vars are removed)
    await updateConfigAndDeploy({ gatewayPath, resources, workerUrl, verbose });

    // Install dependencies for current platform (release tarball may contain different platform binaries)
    await installDependencies({
      cwd: gatewayPath,
      verbose,
      description: "Installing dependencies for migrations...",
    });

    // Run database migrations
    await runDrizzleMigrations({ cwd: gatewayPath, verbose });
  } catch (error) {
    // Check if this is a known Cloudflare error with a user-friendly message
    const cloudflareError = await formatCloudflareError(error);
    if (cloudflareError) {
      console.log(cloudflareError.formatted);
      await exitWithUpdateNotice(1);
    }

    // Unknown error - show the raw message
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

  // Check if SSL is ready (it usually is for existing subdomains)
  const sslReady = await checkSslReady(workerUrl);

  if (!sslReady) {
    // SSL not ready - hand off to step that handles waiting and final messaging
    await waitForSslCertificate({ workerUrl });
    return;
  }

  console.log(chalk.green("\nGateway deployment successful!\n"));

  // SSL is ready - check if the gateway has an owner account
  const hasOwner = await checkGatewayHasOwner(workerUrl);

  if (hasOwner) {
    console.log(`Your Gateway is now live at: ${chalk.cyan(workerUrl)}\n`);
  } else {
    const signUpUrl = `${workerUrl}/sign-up`;
    console.log(`Your Gateway is now live at: ${chalk.cyan(signUpUrl)}\n`);
    console.log(
      chalk.dim(
        "  Create an owner account to get started with your Gateway.\n",
      ),
    );
  }
}
