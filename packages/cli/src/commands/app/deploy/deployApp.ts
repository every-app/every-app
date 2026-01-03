import { updateWranglerConfig } from "@/lib/wrangler-config";
import { getWorkerUrl } from "@/lib/cloudflare";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runMigrations } from "@/commands/app/deploy/steps/runMigrations";
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
 * 1. Setting up Cloudflare resources (D1, KV) with "every-" prefix
 * 2. Updating wrangler.jsonc with resource IDs
 * 3. Installing dependencies
 * 4. Running production migrations
 * 5. Building and deploying to Cloudflare Workers
 * 6. Setting up secrets
 * 7. Registering the app with the gateway
 */
export async function deployApp(
  options: DeployAppOptions,
): Promise<DeployAppResult> {
  const { cwd, appId, verbose, devUrl } = options;

  // Setup Cloudflare resources (D1, KV) - returns prefixed resource name
  const { d1DatabaseId, kvNamespaceId, resourceName } =
    await setupCloudflareResources(appId, verbose);

  // Update wrangler.jsonc with prefixed worker name and resource IDs
  await updateWranglerConfig({
    configPath: cwd,
    name: resourceName,
    d1DatabaseId,
    d1DatabaseName: resourceName,
    kvNamespaceId,
    verbose,
  });

  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  // Install dependencies
  console.log();
  await installDependencies(
    cwd,
    "Installing dependencies for Cloudflare deployment...",
    verbose,
  );

  // Run production migrations
  await runMigrations(cwd, verbose);

  // Build and deploy
  await buildAndDeploy(cwd, gatewayUrl, resourceName, verbose);

  // Setup secrets
  await setupAppSecrets(gatewayUrl, cwd, verbose);

  // Get deployed URL
  const workerUrl = await getWorkerUrl(resourceName);

  // Read app metadata from every-app.jsonc for display name and description
  const config = await readEveryAppConfig(cwd);

  // Register with gateway using unprefixed appId for cleaner URLs
  // (e.g., /apps/todo-app instead of /apps/every-todo-app)
  await insertUserAppRecords({
    appId,
    appUrl: workerUrl,
    verbose,
    appName: config.displayName,
    appDescription: config.description,
    devUrl,
  });

  return { workerUrl, gatewayUrl };
}
