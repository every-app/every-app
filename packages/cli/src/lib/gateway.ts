import chalk from "chalk";
import {
  getWorkerUrl,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare";

const GATEWAY_WORKER_NAME = "every-app-gateway";

/**
 * Check if the gateway has an owner account by querying the hasOwner endpoint
 */
export async function checkGatewayHasOwner(
  gatewayUrl: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${gatewayUrl}/api/admin/has-owner`);
    if (!response.ok) {
      // If endpoint doesn't exist or errors, assume no owner
      return false;
    }
    const data = (await response.json()) as { hasOwner: boolean };
    return data.hasOwner;
  } catch {
    // Network error or other issue - assume no owner
    return false;
  }
}

/**
 * Check if the gateway worker is deployed using the Cloudflare API.
 */
async function checkGatewayDeployed(): Promise<boolean> {
  try {
    const accountId = await getDefaultAccountId();
    // Use the settings endpoint which returns JSON (the script endpoint returns multipart form data)
    await makeCloudflareAPIRequest(
      `/accounts/${accountId}/workers/scripts/${GATEWAY_WORKER_NAME}/settings`,
    );
    return true;
  } catch {
    // API error (likely 404) means worker doesn't exist
    return false;
  }
}

/**
 * Get the gateway URL for the current Cloudflare account
 */
async function getGatewayUrl(): Promise<string> {
  return getWorkerUrl(GATEWAY_WORKER_NAME);
}

interface GatewayStatus {
  isDeployed: boolean;
  hasOwner: boolean;
  gatewayUrl: string;
}

/**
 * Check the gateway deployment status and owner account status.
 * Returns the status and gateway URL.
 */
async function checkGatewayStatus(): Promise<GatewayStatus> {
  const isDeployed = await checkGatewayDeployed();

  if (!isDeployed) {
    const gatewayUrl = await getGatewayUrl();
    return { isDeployed: false, hasOwner: false, gatewayUrl };
  }

  const gatewayUrl = await getGatewayUrl();
  const hasOwner = await checkGatewayHasOwner(gatewayUrl);
  return { isDeployed: true, hasOwner, gatewayUrl };
}

/**
 * Require the gateway to be deployed and have an owner account.
 * Exits the process with a helpful error message if not set up properly.
 */
export async function requireGatewaySetup(): Promise<string> {
  const { isDeployed, hasOwner, gatewayUrl } = await checkGatewayStatus();

  if (!isDeployed) {
    console.log(chalk.yellow("\nGateway not deployed\n"));
    console.log(
      "You need to deploy the Every App Gateway before creating or deploying apps.\n",
    );
    console.log(chalk.dim("  Run: npx @every-app/cli gateway deploy\n"));
    process.exit(1);
  }

  if (!hasOwner) {
    const signUpUrl = `${gatewayUrl}/sign-up`;
    console.log(chalk.yellow("\nOwner account required\n"));
    console.log(
      "You need to create an owner account on your Gateway before deploying apps.\n",
    );
    console.log(`  ${chalk.cyan(signUpUrl)}\n`);
    console.log(
      chalk.dim(
        "  Visit the URL above to create your owner account, then run this command again.\n",
      ),
    );
    process.exit(1);
  }

  return gatewayUrl;
}
