import chalk from "chalk";
import { GatewayClient } from "@/lib/gateway/api";
import { resolveGatewayUrl } from "@/lib/gateway/resolve";

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

function formatGatewayUnreachableError(
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
 * Require a gateway that has been claimed: an app is deployed to, and
 * developed against, a gateway with an owner. Exits with what to do
 * otherwise. Returns the gateway's URL.
 */
export async function requireGatewaySetup(gatewayFlag?: string): Promise<string> {
  let gatewayUrl: string;
  try {
    gatewayUrl = await resolveGatewayUrl(gatewayFlag);
  } catch (error) {
    console.log(chalk.yellow("\nNo gateway found\n"));
    console.log(
      chalk.dim(`  ${error instanceof Error ? error.message : String(error)}\n`),
    );
    process.exit(1);
  }

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
      process.exit(1);
    }
    throw error;
  }

  if (!hasOwner) {
    console.log(chalk.yellow("\nOwner account required\n"));
    console.log(
      `Your Gateway at ${chalk.cyan(gatewayUrl)} has not been claimed yet.\n`,
    );
    console.log(
      chalk.dim(
        "  Open the setup link printed by `everyapp gateway deploy`, or run `everyapp gateway claim-link` for a new one, then run this command again.\n",
      ),
    );
    process.exit(1);
  }

  return gatewayUrl;
}

function reasonForCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
