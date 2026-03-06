import { getValidCloudflareToken } from "@/lib/cloudflare";
import { secretExists, uploadSecret } from "@/lib/secrets";

const GATEWAY_URL_SECRET_NAME = "GATEWAY_URL";
const GATEWAY_APP_API_TOKEN_SECRET_NAME = "GATEWAY_APP_API_TOKEN";
const EVERY_APP_ORG_ID_SECRET_NAME = "EVERY_APP_ORG_ID";
const PROVISION_ENDPOINT_PATH = "/api/internal/app-token/provision";
const DEFAULT_TOKEN_SCOPES = ["provider:openai"];

interface SetupAppSecretsOptions {
  gatewayUrl: string;
  appPath: string;
  appId: string;
  organizationId: string;
  verbose?: boolean;
}

interface ProvisionedTokenResponse {
  token: string;
}

function tryParseJson(text: string): unknown {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function getErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const error = (payload as Record<string, unknown>)["error"];
  if (typeof error !== "string" || !error.trim()) {
    return null;
  }

  return error;
}

export async function provisionGatewayAppApiToken({
  gatewayUrl,
  appId,
  organizationId,
}: {
  gatewayUrl: string;
  appId: string;
  organizationId: string;
}): Promise<string> {
  const cloudflareToken = await getValidCloudflareToken();

  const response = await fetch(`${gatewayUrl}${PROVISION_ENDPOINT_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cloudflareToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      organizationId,
      appSlug: appId,
      scopes: DEFAULT_TOKEN_SCOPES,
    }),
  });

  const responseText = await response.text();
  const payload = tryParseJson(responseText);

  if (!response.ok) {
    const errorMessage =
      getErrorMessage(payload) ||
      `Gateway token provisioning failed with status ${response.status}`;

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `${errorMessage}. Ensure your Cloudflare credentials target the same account that hosts this gateway.`,
      );
    }

    if (response.status === 404) {
      throw new Error(
        "Gateway does not support token provisioning yet. Redeploy the gateway with `npx everyapp gateway deploy` and try again.",
      );
    }

    if (response.status === 409) {
      // Legacy gateway deployments may still enforce a single active token.
      throw new Error(
        `${getErrorMessage(payload) || "Gateway rejected token provisioning with a conflict"}. If this gateway is outdated, run \`npx everyapp gateway deploy\` and try again.`,
      );
    }

    throw new Error(errorMessage);
  }

  const token = (payload as ProvisionedTokenResponse | null)?.token;
  if (typeof token !== "string" || !token.trim()) {
    throw new Error("Gateway returned an invalid token provisioning response");
  }

  return token;
}

/**
 * Setup required secrets for app deployment
 */
export async function setupAppSecrets({
  gatewayUrl,
  appPath,
  appId,
  organizationId,
  verbose = false,
}: SetupAppSecretsOptions): Promise<void> {
  if (verbose) console.log("Configuring Secrets...");

  try {
    // Check and setup GATEWAY_URL
    const gatewayUrlExists = await secretExists({
      secretName: GATEWAY_URL_SECRET_NAME,
      cwd: appPath,
      verbose,
    });
    if (!gatewayUrlExists) {
      await uploadSecret({
        secretName: GATEWAY_URL_SECRET_NAME,
        secretValue: gatewayUrl,
        cwd: appPath,
        verbose,
        description: `Setting GATEWAY_URL to: ${gatewayUrl}`,
      });
    }

    const gatewayAppApiTokenExists = await secretExists({
      secretName: GATEWAY_APP_API_TOKEN_SECRET_NAME,
      cwd: appPath,
      verbose,
    });

    if (!gatewayAppApiTokenExists) {
      if (verbose) {
        console.log("Provisioning gateway app API token...");
      }

      const appToken = await provisionGatewayAppApiToken({
        gatewayUrl,
        appId,
        organizationId,
      });

      await uploadSecret({
        secretName: GATEWAY_APP_API_TOKEN_SECRET_NAME,
        secretValue: appToken,
        cwd: appPath,
        verbose,
        description: "Setting GATEWAY_APP_API_TOKEN for gateway requests",
      });
    }

    const orgIdSecretExists = await secretExists({
      secretName: EVERY_APP_ORG_ID_SECRET_NAME,
      cwd: appPath,
      verbose,
    });
    if (!orgIdSecretExists) {
      await uploadSecret({
        secretName: EVERY_APP_ORG_ID_SECRET_NAME,
        secretValue: organizationId,
        cwd: appPath,
        verbose,
        description: `Setting EVERY_APP_ORG_ID to: ${organizationId}`,
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
