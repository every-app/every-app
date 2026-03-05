import {
  updateWranglerConfig,
  readWranglerConfig,
} from "@/lib/wrangler-config";
import { getWorkerUrl } from "@/lib/cloudflare";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runDrizzleMigrations } from "@/lib/migrations";
import { buildAndDeploy } from "@/commands/app/deploy/steps/buildAndDeploy";
import { insertUserAppRecords } from "@/commands/app/deploy/steps/insertUserAppRecords";
import { setupAppSecrets } from "@/commands/app/deploy/steps/setupAppSecrets";
import { readEveryAppConfig } from "@/lib/everyapp-config";

interface DeployAppOptions {
  cwd: string;
  /** The unprefixed app ID (e.g., "todo-app", not "every-todo-app") */
  appId: string;
  verbose: boolean;
  devUrl?: string;
}

interface DeployAppResult {
  workerUrl: string;
  gatewayUrl: string;
}

/**
 * Shared deployment logic used by both `app create` and `app deploy` commands.
 *
 * This function handles:
 * 1. Setting up Cloudflare resources (D1, KV, and optionally R2) with "every-" prefix
 * 2. Updating wrangler.jsonc with resource IDs
 * 3. Installing dependencies
 * 4. Running production migrations
 * 5. Building and deploying to Cloudflare Workers
 * 6. Registering the app with the gateway
 * 7. Setting up secrets
 */
export async function deployApp(
  options: DeployAppOptions,
): Promise<DeployAppResult> {
  const { cwd, appId, verbose, devUrl } = options;

  // Check if the app needs an R2 bucket by reading wrangler.jsonc
  const wranglerConfig = await readWranglerConfig(cwd);
  const needsR2Bucket = Boolean(wranglerConfig.r2_buckets?.length);

  // Setup Cloudflare resources (D1, KV, and optionally R2) - returns prefixed resource name
  const { d1DatabaseId, kvNamespaceId, r2BucketName, resourceName } =
    await setupCloudflareResources({ appId, needsR2Bucket, verbose });

  // Update wrangler.jsonc with prefixed worker name and resource IDs
  await updateWranglerConfig({
    configPath: cwd,
    name: resourceName,
    d1DatabaseId,
    d1DatabaseName: resourceName,
    kvNamespaceId,
    r2BucketName,
    verbose,
  });

  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  // Install dependencies
  console.log();
  await installDependencies({
    cwd,
    description: "Installing dependencies for Cloudflare deployment...",
    verbose,
  });

  // Run production migrations
  await runDrizzleMigrations({ cwd, verbose });

  // Build and deploy
  await buildAndDeploy({ cwd, gatewayUrl, appId, verbose });

  // Get deployed URL
  const workerUrl = await getWorkerUrl(resourceName);

  // Read app metadata from every-app.jsonc for display name and description
  const config = await readEveryAppConfig(cwd);

  // Register with gateway using unprefixed appId for cleaner URLs
  // (e.g., /apps/todo-app instead of /apps/every-todo-app)
  await insertUserAppRecords({
    appId,
    appUrl: workerUrl,
    gatewayUrl,
    verbose,
    appName: config.displayName,
    appDescription: config.description,
    devUrl,
  });

  // Setup app-level secrets after gateway registration so app token provisioning
  // can resolve this app in the gateway catalog.
  await setupAppSecrets({ gatewayUrl, appPath: cwd, appId, verbose });

  return { workerUrl, gatewayUrl };
}
