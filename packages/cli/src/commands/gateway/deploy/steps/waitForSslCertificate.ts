import chalk from "chalk";
import {
  checkGatewayHasOwner,
  checkSslReady,
  formatGatewayUnreachableError,
  GatewayUnreachableError,
} from "@/lib/gateway";

interface WaitForSslCertificateOptions {
  workerUrl: string;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

/**
 * Wait for SSL certificate to be provisioned for a newly deployed worker.
 * Handles the entire post-deployment flow for new subdomains where SSL isn't immediately ready.
 */
export async function waitForSslCertificate({
  workerUrl,
  maxWaitMs = 120000,
  pollIntervalMs = 3000,
}: WaitForSslCertificateOptions): Promise<void> {
  const signUpUrl = `${workerUrl}/sign-up`;

  console.log(chalk.green("\nGateway deployment successful!\n"));
  console.log(`Your Gateway will be available at: ${chalk.cyan(signUpUrl)}\n`);
  console.log(chalk.dim("Waiting for SSL certificate to be provisioned..."));

  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    let sslReady = false;
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

    if (sslReady) {
      console.log(chalk.green("SSL certificate is ready!\n"));

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
        console.log(`Your Gateway is now live at: ${chalk.cyan(signUpUrl)}\n`);
        console.log(
          chalk.dim(
            "  Create an owner account to get started with your Gateway.\n",
          ),
        );
      }
      return;
    }
  }

  // Timed out waiting for SSL
  console.log(
    chalk.yellow(
      "\nSSL certificate is still being provisioned. This can take a few minutes.\n",
    ),
  );
  console.log(
    chalk.dim(
      "  The URL above will be accessible once the SSL certificate is ready.\n",
    ),
  );
  console.log(
    chalk.dim("  Create an owner account to get started with your Gateway.\n"),
  );
}
