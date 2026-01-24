import chalk from "chalk";
import { executeCommandWithFormatting } from "@/lib/formatting";
import { formatCloudflareError } from "@/lib/cloudflare/errors";
import { exitWithUpdateNotice } from "@/lib/version-check";

interface BuildAndDeployOptions {
  cwd: string;
  gatewayUrl: string;
  /** The unprefixed app ID (e.g., "todo-app") used to set VITE_APP_ID */
  appId: string;
  verbose: boolean;
}

/**
 * Build and deploy the app to Cloudflare Workers
 */
export async function buildAndDeploy({
  cwd,
  gatewayUrl,
  appId,
  verbose,
}: BuildAndDeployOptions): Promise<void> {
  const deployEnv = {
    ...process.env,
    VITE_GATEWAY_URL: gatewayUrl,
    VITE_APP_ID: appId,
  };

  try {
    // Build the app
    await executeCommandWithFormatting("npx", ["vite", "build"], {
      cwd,
      description: "Building your application...\n",
      env: deployEnv,
      verbose,
    });

    // Deploy to Cloudflare
    await executeCommandWithFormatting("npx", ["wrangler", "deploy"], {
      cwd,
      description:
        "Deploying your application to Cloudflare workers...\n\n  This could take up to a minute.",
      env: deployEnv,
      verbose,
    });
  } catch (error) {
    // Check if this is a known Cloudflare error with a user-friendly message
    const cloudflareError = await formatCloudflareError(error);
    if (cloudflareError) {
      console.log(cloudflareError.formatted);
      await exitWithUpdateNotice(1);
    }

    console.error(chalk.red("\nFailed to build or deploy"));
    throw error;
  }
}
