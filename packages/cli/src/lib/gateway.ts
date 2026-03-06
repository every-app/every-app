import chalk from "chalk";
import { exitWithUpdateNotice } from "@/lib/version-check";
import {
  getWorkerUrl,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare";

const GATEWAY_WORKER_NAME = "every-app-gateway";

/**
 * Check if SSL certificate is ready for a given URL.
 * Returns true if the connection succeeds, false if there's an SSL error.
 */
export async function checkSslReady(url: string): Promise<boolean> {
  try {
    await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
    });
    // Any response (even 404) means SSL is working
    return true;
  } catch (error) {
    // Check for SSL-related errors
    const errorMessage =
      error instanceof Error ? error.message.toLowerCase() : "";
    const errorCode =
      error instanceof Error && "cause" in error
        ? (error.cause as { code?: string })?.code?.toLowerCase() || ""
        : "";

    const sslErrorIndicators = [
      "ssl",
      "tls",
      "certificate",
      "cert",
      "cipher",
      "handshake",
      "secure",
    ];

    const isSslError = sslErrorIndicators.some(
      (indicator) =>
        errorMessage.includes(indicator) || errorCode.includes(indicator),
    );

    if (isSslError) {
      return false;
    }

    // For non-SSL errors (network issues, etc.), assume SSL is ready
    // This prevents blocking on unrelated network problems
    return true;
  }
}

/**
 * Check if the gateway has an owner account by querying the hasOwner endpoint
 */
export async function checkGatewayHasOwner(
  gatewayUrl: string,
): Promise<boolean> {
  try {
    // This endpoint is intentionally public because it is queried before
    // authentication exists during initial gateway bootstrap.
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
    console.log(chalk.dim("  Run: npx everyapp gateway deploy\n"));
    await exitWithUpdateNotice(1);
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
    await exitWithUpdateNotice(1);
  }

  return gatewayUrl;
}
