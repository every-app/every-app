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
  try {
    const deployEnv = {
      ...process.env,
      VITE_GATEWAY_URL: gatewayUrl,
      VITE_APP_ID: appId,
    };

    await executeCommandWithFormatting("npm", ["run", "deploy"], {
      cwd,
      description:
        "Deploying your application to Cloudflare workers...\n\n  15s to 1m depending on how long the app build takes\n",
      env: deployEnv,
      verbose,
    });
  } catch (error) {
    console.error(chalk.red("\nFailed to build or deploy"));
    throw error;
  }
}
