import { secretExists, uploadSecret } from "@/lib/secrets";

interface SetupAppSecretsOptions {
  gatewayUrl: string;
  appPath: string;
  verbose?: boolean;
}

/**
 * Setup GATEWAY_URL secret for app deployment
 */
export async function setupAppSecrets({
  gatewayUrl,
  appPath,
  verbose = false,
}: SetupAppSecretsOptions): Promise<void> {
  if (verbose) console.log("Configuring Secrets...");

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists({
      secretName: "GATEWAY_URL",
      cwd: appPath,
      verbose,
    });
    if (!gatewayUrlExists) {
      await uploadSecret({
        secretName: "GATEWAY_URL",
        secretValue: gatewayUrl,
        cwd: appPath,
        verbose,
        description: `Setting GATEWAY_URL to: ${gatewayUrl}`,
      });
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
