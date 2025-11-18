import crypto from "node:crypto";
import { setupSecrets } from "@/commands/gateway/deploy/setupSecrets";
import { updateWranglerConfig } from "@/lib/wrangler-config";
import { executeCommandWithFormatting } from "@/lib/formatting";
import type { CloudflareResources } from "@/commands/gateway/deploy/types";

/**
 * Update wrangler config with resources and deploy
 */
export async function updateConfigAndDeploy(
  gatewayPath: string,
  resources: CloudflareResources,
  workerUrl: string,
  verbose: boolean = false,
): Promise<void> {
  // Update wrangler config with resource IDs and vars
  await updateWranglerConfig({
    configPath: gatewayPath,
    d1DatabaseId: resources.d1DatabaseId,
    kvNamespaceId: resources.kvNamespaceId,
    vars: { GATEWAY_URL: workerUrl },
    verbose,
  });

  // Set up secrets after removing conflicting vars
  await setupSecrets(workerUrl, gatewayPath, verbose);

  // Generate a random secret for build time only (actual secret is set via Cloudflare secrets)
  const buildTimeSecret = crypto.randomUUID();

  await executeCommandWithFormatting("npm", ["run", "deploy"], {
    cwd: gatewayPath,
    description:
      "Deploying your Gateway to Cloudflare workers...\n\n  This could take up to a minute.",
    env: {
      ...process.env,
      BETTER_AUTH_SECRET: buildTimeSecret,
    },
    verbose,
  });
}
