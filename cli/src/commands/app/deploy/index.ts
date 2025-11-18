import type { LocalContext } from "@/context";
import chalk from "chalk";
import { readWranglerConfig, updateWranglerConfig } from "@/lib/wrangler-config";
import { getWorkerUrl } from "@/lib/cloudflare-auth";
import { confirmDeployment } from "@/lib/deployment";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runMigrations } from "@/commands/app/deploy/steps/runMigrations";
import { buildAndDeploy } from "@/commands/app/deploy/steps/buildAndDeploy";
import { insertUserAppRecords } from "@/commands/app/deploy/steps/insertUserAppRecords";

interface DeployCommandFlags {
  verbose?: boolean;
}

/**
 * Main deploy command implementation
 */
export async function deploy(
  this: LocalContext,
  flags: DeployCommandFlags,
): Promise<void> {
  const cwd = process.cwd();
  const verbose = flags.verbose || false;

  // Step 1: Read wrangler config
  const config = await readWranglerConfig(cwd);

  if (!config.name) {
    throw new Error(
      "Worker name not found in wrangler.jsonc. Please add a 'name' field.",
    );
  }

  const workerName = config.name;
  console.log(chalk.bold(`\nProject name: ${workerName}\n`));

  // Step 2: Confirm deployment
  const confirmed = await confirmDeployment(
    "Do you want to deploy this app to Cloudflare?",
  );
  if (!confirmed) {
    console.log(chalk.red("\nDeployment cancelled by user\n"));
    return;
  }

  // Step 3: Set up Cloudflare resources
  const { d1DatabaseId, kvNamespaceId } = await setupCloudflareResources(
    config,
    workerName,
    verbose,
  );

  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  // Step 4: Update wrangler.jsonc with resource IDs and vars
  await updateWranglerConfig({
    configPath: cwd,
    d1DatabaseId,
    kvNamespaceId,
    vars: { GATEWAY_URL: gatewayUrl },
    verbose,
  });

  // Step 5: Ensure dependencies are installed
  console.log();
  await installDependencies(
    cwd,
    "Installing dependencies for Cloudflare deployment...",
    verbose,
  );

  // Step 6: Run migrations
  await runMigrations(cwd, config, verbose);

  // Step 7: Build and deploy
  await buildAndDeploy(cwd, gatewayUrl, workerName, verbose);

  // Step 8: Get worker URL
  const workerUrl = await getWorkerUrl(config.name);

  // Step 9: Insert UserApp records with custom metadata for known apps
  let appName: string | undefined;
  let appDescription: string | undefined;

  // TODO: Remove once we accept yaml configs for apps
  if (config.name === "every-todo-app") {
    appName = "Todos";
    appDescription = "Minimal todo list";
  }

  await insertUserAppRecords(
    config.name,
    workerUrl,
    verbose,
    appName,
    appDescription,
  );

  // Step 10: Show success message
  console.log(chalk.green("Deployment successful!\n"));

  const gatewayUrlFromDeployment = await getWorkerUrl("every-app-gateway");
  console.log(
    `Try it out in your gateway: ${chalk.cyan(gatewayUrlFromDeployment)}\n`,
  );
}
