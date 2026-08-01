import chalk from "chalk";
import { exitWithUpdateNotice } from "@/lib/version-check";
import type { EveryAppManifest } from "@every-app/perimeter/manifest";
import {
  GatewayClient,
  isGatewayAuthError,
  isGatewayInternalApisDisabledError,
  isOutdatedGatewayError,
} from "@/lib/gateway/api";

interface RegisterAppWithGatewayOptions {
  appId: string;
  workerName: string;
  manifest: EveryAppManifest;
  gatewayUrl: string;
  verbose?: boolean;
  appName?: string;
  appDescription?: string;
}

interface RegisterAppWithGatewayResult {
  hostname: string;
}

interface GatewayDeploymentInfo {
  organizationId: string;
  gatewayBinding?: { organizationId: string };
}

export async function fetchGatewayIdentityKeys(
  gatewayUrl: string,
): Promise<{ issuer?: string | null; keys: string[] }> {
  const client = new GatewayClient({
    gatewayUrl,
  });
  return client.getIdentityKeys();
}

/** Resolve token-scoped deployment identity and advertised gateway features. */
export async function resolveGatewayDeploymentInfo(
  gatewayUrl: string,
): Promise<GatewayDeploymentInfo> {
  try {
    const client = new GatewayClient({ gatewayUrl });
    const whoami = await client.whoami();
    if (whoami.capabilities?.appGateway === true) {
      return {
        organizationId: whoami.organizationId,
        gatewayBinding: { organizationId: whoami.organizationId },
      };
    }

    console.log(
      chalk.yellow(
        "Upgrade your gateway to enable the AI proxy binding: npx everyapp gateway deploy",
      ),
    );
    return { organizationId: whoami.organizationId };
  } catch (error) {
    await handleRegistrationError(error);
    throw error;
  }
}

export async function registerAppWithGateway(
  options: RegisterAppWithGatewayOptions,
): Promise<RegisterAppWithGatewayResult> {
  const {
    appId,
    workerName,
    manifest,
    gatewayUrl,
    verbose = false,
    appName,
    appDescription,
  } = options;

  try {
    console.log("");
    if (verbose) {
      console.log("Registering app with gateway control plane...");
    }

    const client = new GatewayClient({
      gatewayUrl,
    });
    const displayName = appName || appId;
    const displayDescription = appDescription || appId;

    const registerResponse = await client.registerApp({
      appId,
      name: displayName,
      description: displayDescription,
      workerName,
      manifest,
    });

    if (verbose) {
      console.log(
        chalk.dim(
          `  Gateway app: ${registerResponse.appSlug} (${registerResponse.existingApp ? "updated" : "created"})`,
        ),
      );
      console.log(
        chalk.dim(
          `  Default access: ${registerResponse.defaultAccess ? "enabled" : "disabled"}`,
        ),
      );
      console.log(
        chalk.dim(
          `  Access granted to ${registerResponse.grantedUserCount} users\n`,
        ),
      );
    }

    return {
      hostname: registerResponse.hostname,
    };
  } catch (error) {
    await handleRegistrationError(error);
    throw error;
  }
}

async function handleRegistrationError(error: unknown): Promise<void> {
  if (isOutdatedGatewayError(error)) {
    console.log(chalk.yellow("\nGateway out of date\n"));
    console.log(chalk.dim("  Run: `npx everyapp gateway deploy` to update.\n"));
    await exitWithUpdateNotice(1);
  }

  if (isGatewayAuthError(error)) {
    console.log(chalk.yellow("\nGateway authorization failed\n"));
    console.log(chalk.dim(`${error.message}\n`));
    await exitWithUpdateNotice(1);
  }

  if (isGatewayInternalApisDisabledError(error)) {
    console.log(chalk.yellow("\nGateway internal APIs are disabled\n"));
    console.log(
      chalk.dim(
        "  This gateway is running in hosted mode (or has invalid deployment mode config), so /api/deploy/* is intentionally unavailable.\n",
      ),
    );
    await exitWithUpdateNotice(1);
  }

  console.error(
    chalk.red("\nFailed to register app with gateway"),
    error instanceof Error ? `\n   ${error.message}\n` : "",
  );
}
