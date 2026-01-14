import chalk from "chalk";
import { checkGatewayHasOwner, checkSslReady } from "@/lib/gateway";

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

    if (await checkSslReady(workerUrl)) {
      console.log(chalk.green("SSL certificate is ready!\n"));

      // SSL is ready - check if the gateway has an owner account
      const hasOwner = await checkGatewayHasOwner(workerUrl);

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
