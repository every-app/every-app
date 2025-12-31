import {
  readWranglerConfig,
  updateWranglerConfig,
  type WranglerConfig,
} from "@/lib/wrangler-config";
import { getWorkerUrl } from "@/lib/cloudflare-auth";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runMigrations } from "@/commands/app/deploy/steps/runMigrations";
import { buildAndDeploy } from "@/commands/app/deploy/steps/buildAndDeploy";
import { insertUserAppRecords } from "@/commands/app/deploy/steps/insertUserAppRecords";
import { setupAppSecrets } from "@/commands/app/deploy/steps/setupAppSecrets";

interface DeployAppOptions {
  cwd: string;
  workerName: string;
  verbose: boolean;
  devUrl?: string;
  /** Pre-loaded wrangler config to avoid redundant file reads */
  config?: WranglerConfig;
}

interface DeployAppResult {
  workerUrl: string;
  gatewayUrl: string;
}

/**
 * Known app metadata for better display names in the gateway
 */
const KNOWN_APP_METADATA: Record<
  string,
  { name: string; description: string }
> = {
  "every-todo-app": {
    name: "Todos",
    description: "Minimal todo list",
  },
  "every-chef": {
    name: "Chef",
    description: "AI-powered recipes and cooking assistant",
  },
  "workout-tracker": {
    name: "Workout Tracker",
    description: "Create custom programs and track your workouts",
  },
};

/**
 * Shared deployment logic used by both `app create` and `app deploy` commands.
 *
 * This function handles:
 * 1. Setting up Cloudflare resources (D1, KV)
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
  const { cwd, workerName, verbose, devUrl } = options;

  // Use provided config or read from disk
  const config = options.config ?? (await readWranglerConfig(cwd));

  // Setup Cloudflare resources (D1, KV)
  const { d1DatabaseId, kvNamespaceId } = await setupCloudflareResources(
    config,
    workerName,
    verbose,
  );

  // Update wrangler.jsonc with worker name and resource IDs
  await updateWranglerConfig({
    configPath: cwd,
    name: workerName,
    d1DatabaseId,
    d1DatabaseName: workerName,
    kvNamespaceId,
    verbose,
  });

  // Re-read config after update
  const updatedConfig = await readWranglerConfig(cwd);

  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  // Install dependencies
  console.log();
  await installDependencies(
    cwd,
    "Installing dependencies for Cloudflare deployment...",
    verbose,
  );

  // Run production migrations
  await runMigrations(cwd, updatedConfig, verbose);

  // Build and deploy
  await buildAndDeploy(cwd, gatewayUrl, workerName, verbose);

  // Setup secrets
  await setupAppSecrets(gatewayUrl, cwd, verbose);

  // Get deployed URL
  const workerUrl = await getWorkerUrl(workerName);

  // Register with gateway (use known metadata if available)
  const knownMetadata = KNOWN_APP_METADATA[workerName];
  await insertUserAppRecords(
    workerName,
    workerUrl,
    verbose,
    knownMetadata?.name,
    knownMetadata?.description,
    devUrl,
  );

  return { workerUrl, gatewayUrl };
}
