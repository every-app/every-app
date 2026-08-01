import { GatewayClient } from "@/lib/gateway/api";
import { secretExists, uploadSecret } from "@/lib/secrets";

const GATEWAY_URL_SECRET_NAME = "GATEWAY_URL";
const EVERY_APP_ORG_ID_SECRET_NAME = "EVERY_APP_ORG_ID";

interface SetupAppSecretsOptions {
  gatewayUrl: string;
  appPath: string;
  workerName: string;
  verbose?: boolean;
}

/**
 * Setup required secrets for app deployment
 */
export async function setupAppSecrets({
  gatewayUrl,
  appPath,
  workerName,
  verbose = false,
}: SetupAppSecretsOptions): Promise<void> {
  if (verbose) console.log("Configuring Secrets...");

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists({
      secretName: GATEWAY_URL_SECRET_NAME,
      cwd: appPath,
      workerName,
      verbose,
    });
    if (!gatewayUrlExists) {
      await uploadSecret({
        secretName: GATEWAY_URL_SECRET_NAME,
        secretValue: gatewayUrl,
        cwd: appPath,
        workerName,
        verbose,
        description: `Setting GATEWAY_URL to: ${gatewayUrl}`,
      });
    }

    const orgIdSecretExists = await secretExists({
      secretName: EVERY_APP_ORG_ID_SECRET_NAME,
      cwd: appPath,
      workerName,
      verbose,
    });
    if (!orgIdSecretExists) {
      const client = new GatewayClient({ gatewayUrl });
      const whoami = await client.whoami();
      await uploadSecret({
        secretName: EVERY_APP_ORG_ID_SECRET_NAME,
        secretValue: whoami.organizationId,
        cwd: appPath,
        workerName,
        verbose,
        description: `Setting EVERY_APP_ORG_ID to: ${whoami.organizationId}`,
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
