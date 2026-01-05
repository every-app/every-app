import crypto from "node:crypto";
import path from "node:path";
import { setupSecrets } from "@/commands/gateway/deploy/setupSecrets";
import { updateWranglerConfig } from "@/lib/wrangler-config";
import { executeCommandWithFormatting } from "@/lib/formatting";
import type { CloudflareResources } from "@/commands/gateway/deploy/types";

interface UpdateConfigAndDeployOptions {
  gatewayPath: string;
  resources: CloudflareResources;
  workerUrl: string;
  verbose?: boolean;
}

/**
 * Update wrangler config with resources and deploy
 */
export async function updateConfigAndDeploy({
  gatewayPath,
  resources,
  workerUrl,
  verbose = false,
}: UpdateConfigAndDeployOptions): Promise<void> {
  // Update the built wrangler.json with resource IDs
  // (wrangler uses .wrangler/deploy/config.json to read from dist/server/wrangler.json)
  const builtConfigPath = path.join(
    gatewayPath,
    "dist",
    "server",
    "wrangler.json",
  );
  await updateWranglerConfig({
    configPath: builtConfigPath,
    d1DatabaseId: resources.d1DatabaseId,
    kvNamespaceId: resources.kvNamespaceId,
    verbose,
  });

  // Generate a random secret for build time only (actual secret is set via Cloudflare secrets)
  const buildTimeSecret = crypto.randomUUID();

  // Deploy to Cloudflare
  console.log();
  await executeCommandWithFormatting("npx", ["wrangler", "deploy"], {
    cwd: gatewayPath,
    description:
      "Deploying your Gateway to Cloudflare workers...\n\n  This could take up to a minute.",
    env: {
      ...process.env,
      BETTER_AUTH_SECRET: buildTimeSecret,
    },
    verbose,
  });

  // New line
  console.log();
  // Set up secrets after the worker is deployed
  await setupSecrets({ gatewayUrl: workerUrl, gatewayPath, verbose });
}
