import { secretExists, uploadSecret } from "@/lib/secrets";

/**
 * Setup GATEWAY_URL secret for app deployment
 */
export async function setupAppSecrets(
  gatewayUrl: string,
  appPath: string,
  verbose: boolean = false,
): Promise<void> {
  if (verbose) console.log("Configuring Secrets...");

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists(
      "GATEWAY_URL",
      appPath,
      verbose,
    );
    if (!gatewayUrlExists) {
      await uploadSecret(
        "GATEWAY_URL",
        gatewayUrl,
        appPath,
        verbose,
        `Setting GATEWAY_URL to: ${gatewayUrl}`,
      );
    }

    if (verbose) {
      console.log("Secret setup complete!\n");
    }
  } catch (error) {
    console.error(
      "\nFailed to setup secrets",
      error instanceof Error ? `\n   ${error.message}` : "",
    );
    throw error;
  }
}
