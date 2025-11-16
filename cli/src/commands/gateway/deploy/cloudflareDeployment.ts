import path from "node:path";
import crypto from "node:crypto";
import chalk from "chalk";
import { getOrCreateD1Database } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";
import { getDefaultAccountId } from "@/lib/cloudflare-auth";
import { setupSecrets } from "@/commands/gateway/deploy/cloudflareSecrets";
import { updateWranglerConfig } from "@/lib/wrangler-config";
import { cloneRepository } from "@/lib/git";
import { installDependencies } from "@/lib/package-manager";
import { execWithIndentedOutput } from "@/lib/formatting";
import type { CloudflareResources } from "@/commands/gateway/deploy/types";

// Constants
const EVERY_APP_REPO = "git@github.com:every-app/every-app.git";
const D1_DATABASE_NAME = "every-app-gateway";
const KV_NAMESPACE_NAME = "every-app-gateway";
const HOMEBASE_RELATIVE_PATH = "apps/every-app-gateway";

export async function setupCloudflareResources(): Promise<CloudflareResources> {
  console.log(chalk.bold("\nSetting up Cloudflare resources...\n"));

  const accountId = await getDefaultAccountId();

  const d1DatabaseId = await getOrCreateD1Database(D1_DATABASE_NAME);
  const kvNamespaceId = await getOrCreateKVNamespace(KV_NAMESPACE_NAME);

  return { d1DatabaseId, kvNamespaceId, accountId };
}

export async function cloneAndInstall(
  tmpDir: string,
  verbose: boolean = false,
): Promise<string> {
  console.log(chalk.bold("Cloning gateway repository..."));
  console.log(chalk.dim(`   Repository: ${EVERY_APP_REPO}\n`));

  try {
    await cloneRepository(EVERY_APP_REPO, tmpDir, verbose);

    const gatewayPath = path.join(tmpDir, HOMEBASE_RELATIVE_PATH);

    console.log(
      chalk.bold("Installing dependencies in apps/every-app-gateway...\n"),
    );

    await installDependencies("pnpm", gatewayPath, verbose);

    console.log(chalk.green("Installation complete!\n"));

    return gatewayPath;
  } catch (error) {
    console.error(
      chalk.red("\nFailed to clone repository or install dependencies"),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}

export async function updateConfigAndDeploy(
  gatewayPath: string,
  resources: CloudflareResources,
  workerUrl: string,
  verbose: boolean = false,
): Promise<void> {
  try {
    const wranglerConfigPath = path.join(gatewayPath, "wrangler.jsonc");

    await updateWranglerConfig(wranglerConfigPath, {
      d1DatabaseId: resources.d1DatabaseId,
      kvNamespaceId: resources.kvNamespaceId,
    });

    // Set up secrets after removing conflicting vars
    await setupSecrets(workerUrl, gatewayPath);

    console.log(chalk.bold("Deploying to Cloudflare...\n"));

    // Generate a random secret for build time only (actual secret is set via Cloudflare secrets)
    const buildTimeSecret = crypto.randomUUID();

    await execWithIndentedOutput("npm", ["run", "deploy"], {
      cwd: gatewayPath,
      stdio: "inherit",
      env: {
        ...process.env,
        BETTER_AUTH_SECRET: buildTimeSecret,
      },
      verbose,
    });
  } catch (error) {
    console.error(
      chalk.red("\nFailed to update config or deploy"),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}
