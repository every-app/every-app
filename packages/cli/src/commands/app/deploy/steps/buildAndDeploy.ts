import chalk from "chalk";
import { executeCommandWithFormatting } from "@/lib/formatting";

/**
 * Build and deploy the app to Cloudflare Workers
 */
export async function buildAndDeploy(
  cwd: string,
  gatewayUrl: string,
  appId: string,
  verbose: boolean,
): Promise<void> {
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
    console.error(chalk.red("\nFailed to build or deploy"));
    throw error;
  }
}
