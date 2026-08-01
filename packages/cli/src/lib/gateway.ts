import chalk from "chalk";
import { exitWithUpdateNotice } from "@/lib/version-check";
import {
  getGatewayPublicUrl,
  getDefaultAccountId,
  makeCloudflareAPIRequest,
} from "@/lib/cloudflare";
import { GatewayClient } from "@/lib/gateway/api";

const GATEWAY_WORKER_NAME = "every-app-gateway";

export class GatewayUnreachableError extends Error {
  url: string;
  override cause: unknown;

  constructor(url: string, cause: unknown) {
    super(`Could not reach your Gateway at ${url} (${reasonForCause(cause)})`);
    this.name = "GatewayUnreachableError";
    this.url = url;
    this.cause = cause;
  }
}

export function formatGatewayUnreachableError(
  error: GatewayUnreachableError,
): string {
  return `Could not reach your Gateway at ${error.url} (${reasonForCause(error.cause)})`;
}

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

    throw new GatewayUnreachableError(url, error);
  }
}

/**
 * Check if the gateway has an owner account by querying the hasOwner endpoint
 */
export async function checkGatewayHasOwner(
  gatewayUrl: string,
): Promise<boolean> {
  const client = new GatewayClient({
    gatewayUrl,
    getAuthToken: async () => "",
  });
  try {
    return await client.hasOwner();
  } catch (error) {
    throw new GatewayUnreachableError(gatewayUrl, error);
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
  return getGatewayPublicUrl();
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
  let hasOwner: boolean;
  try {
    hasOwner = await checkGatewayHasOwner(gatewayUrl);
  } catch (error) {
    if (error instanceof GatewayUnreachableError) {
      console.log(chalk.yellow("\nGateway unreachable\n"));
      console.log(formatGatewayUnreachableError(error));
      console.log(
        chalk.dim(
          "  Confirm the gateway URL is correct and reachable, then run this command again.\n",
        ),
      );
      await exitWithUpdateNotice(1);
    }
    throw error;
  }
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

function reasonForCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
