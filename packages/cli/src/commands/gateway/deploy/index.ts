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
import {
  computeGatewayServiceBindings,
  ensureProxiedWildcardDnsRecord,
  verifyZoneOnAccount,
} from "@/lib/cloudflare";
import { exitWithUpdateNotice } from "@/lib/version-check";
import { formatCloudflareError } from "@/lib/cloudflare/errors";
import {
  buildLocalGatewayRelease,
  extractBundledGatewayRelease,
  extractLocalGatewayTarball,
} from "@/lib/gateway-release";
import {
  checkGatewayHasOwner,
  checkSslReady,
  formatGatewayUnreachableError,
  GatewayUnreachableError,
} from "@/lib/gateway";
import { waitForSslCertificate } from "@/commands/gateway/deploy/steps/waitForSslCertificate";
import { installDependencies } from "@/lib/package-manager";
import { formatWildcardDnsInstructions } from "@/lib/dnsInstructions";

export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  await requireCloudflareAuth({ showNewUserHelp: true });

  const verbose = flags.verbose || false;
  const localGateway = flags.localGateway;
  const domain = flags.domain?.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const skipConfirmation = flags.yes || false;

  console.log(chalk.bold("\nEvery App Gateway\n"));

  const confirmed = await confirmDeployment("the Gateway", skipConfirmation);
  if (!confirmed) {
    console.log("\nDeployment cancelled by user\n");
    return;
  }

  // In workers.dev mode, first-time accounts need to claim a subdomain.
  if (!domain) {
    await ensureWorkersDevSubdomain();
  }

  const resources = await setupCloudflareResources({ verbose });

  if (domain) {
    console.log(chalk.dim(`Verifying Cloudflare zone for ${domain}...`));
    const zone = await verifyZoneOnAccount({
      accountId: resources.accountId,
      domain,
    });
    const wildcardDns = await ensureProxiedWildcardDnsRecord({
      zoneId: zone.id,
      domain,
    });
    if (wildcardDns === "unauthorized") {
      console.log(
        chalk.yellow(
          formatWildcardDnsInstructions({
            domain,
            accountId: resources.accountId,
            mode: "gateway-warning",
          }),
        ),
      );
    } else if (verbose) {
      console.log(
        chalk.dim(
          wildcardDns === "created"
            ? `  Created proxied wildcard DNS record for *.${domain}`
            : `  Proxied wildcard DNS record already exists for *.${domain}`,
        ),
      );
    }
  } else {
    console.log(
      chalk.yellow(
        "Warning: app subdomains require a custom domain. Redeploy the gateway with --domain <apex-domain> before deployed apps are routable.",
      ),
    );
  }

  const serviceBindings = await computeGatewayServiceBindings(
    resources.accountId,
  );
  if (verbose) {
    console.log(
      chalk.dim(
        `Reconstructed ${serviceBindings.length} gateway service binding${serviceBindings.length === 1 ? "" : "s"} from the registry.`,
      ),
    );
  }

  // Extract an explicitly supplied or bundled gateway tarball, falling back to
  // a local source build when developing inside the monorepo.
  const tmpDir = await createTempDirectory("gateway-deploy-");
  if (verbose) {
    console.log(chalk.dim(`Working directory: ${tmpDir}\n`));
  }

  let workerUrl = null;
  try {
    let gatewayPath: string | null;
    if (localGateway) {
      gatewayPath = await extractLocalGatewayTarball(
        localGateway,
        tmpDir,
        verbose,
      );
    } else {
      gatewayPath = await extractBundledGatewayRelease(tmpDir, verbose);
      gatewayPath ??= await buildLocalGatewayRelease(
        tmpDir,
        process.cwd(),
        verbose,
      );
    }

    // Install dependencies for the current platform before running Wrangler.
    await installDependencies({
      cwd: gatewayPath,
      verbose,
      description: "Installing gateway dependencies...",
    });

    // Predict worker URL
    const wranglerConfigPath = path.join(gatewayPath, "wrangler.jsonc");
    const workerName = await getWorkerName(wranglerConfigPath);
    const workersDevUrl = domain
      ? `https://${domain}`
      : await getWorkerUrl(workerName);
    workerUrl = domain ? `https://${domain}` : workersDevUrl;

    // Update config and deploy (secrets are set inside this function after deploy)
    await updateConfigAndDeploy({
      gatewayPath,
      resources,
      workerUrl: workersDevUrl,
      domain,
      serviceBindings,
      verbose,
    });

    // Run database migrations against the gateway's own D1: the release dir
    // has no everyapp.config.ts, so the app-manifest lookup path can't run.
    await runDrizzleMigrations({
      cwd: gatewayPath,
      d1DatabaseId: resources.d1DatabaseId,
      verbose,
    });
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
  let sslReady: boolean;
  try {
    sslReady = await checkSslReady(workerUrl);
  } catch (error) {
    if (error instanceof GatewayUnreachableError) {
      console.log(chalk.yellow("\nGateway unreachable\n"));
      console.log(formatGatewayUnreachableError(error));
      console.log(
        chalk.dim(
          "  Confirm the gateway URL is correct and reachable, then run this command again.\n",
        ),
      );
      return;
    }
    throw error;
  }

  if (!sslReady) {
    // SSL not ready - hand off to step that handles waiting and final messaging
    await waitForSslCertificate({ workerUrl });
    return;
  }

  console.log(chalk.green("\nGateway deployment successful!\n"));

  // SSL is ready - check if the gateway has an owner account
  let hasOwner: boolean;
  try {
    hasOwner = await checkGatewayHasOwner(workerUrl);
  } catch (error) {
    if (error instanceof GatewayUnreachableError) {
      console.log(chalk.yellow("\nGateway unreachable\n"));
      console.log(formatGatewayUnreachableError(error));
      console.log(
        chalk.dim(
          "  Confirm the gateway URL is correct and reachable, then run this command again.\n",
        ),
      );
      return;
    }
    throw error;
  }

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
