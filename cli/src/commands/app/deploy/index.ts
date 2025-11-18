import type { LocalContext } from "@/context";
import chalk from "chalk";
import {
  readWranglerConfig,
  updateWranglerConfig,
} from "@/lib/wrangler-config";
import { getWorkerUrl } from "@/lib/cloudflare-auth";
import { confirmDeployment } from "@/lib/deployment";
import { installDependencies } from "@/lib/package-manager";
import { setupCloudflareResources } from "@/commands/app/deploy/steps/setupCloudflareResources";
import { runMigrations } from "@/commands/app/deploy/steps/runMigrations";
import { buildAndDeploy } from "@/commands/app/deploy/steps/buildAndDeploy";
import { insertUserAppRecords } from "@/commands/app/deploy/steps/insertUserAppRecords";
import { setupAppSecrets } from "@/commands/app/deploy/steps/setupAppSecrets";

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

  const config = await readWranglerConfig(cwd);

  if (!config.name) {
    throw new Error(
      "Worker name not found in wrangler.jsonc. Please add a 'name' field.",
    );
  }

  const workerName = config.name;
  console.log(chalk.bold(`\nProject name: ${workerName}\n`));

  const confirmed = await confirmDeployment(
    "Do you want to deploy this app to Cloudflare?",
  );
  if (!confirmed) {
    console.log(chalk.red("\nDeployment cancelled by user\n"));
    return;
  }

  const { d1DatabaseId, kvNamespaceId } = await setupCloudflareResources(
    config,
    workerName,
    verbose,
  );

  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  await updateWranglerConfig({
    configPath: cwd,
    d1DatabaseId,
    kvNamespaceId,
    verbose,
  });

  console.log();
  await installDependencies(
    cwd,
    "Installing dependencies for Cloudflare deployment...",
    verbose,
  );

  await runMigrations(cwd, config, verbose);

  await buildAndDeploy(cwd, gatewayUrl, workerName, verbose);

  await setupAppSecrets(gatewayUrl, cwd, verbose);

  const workerUrl = await getWorkerUrl(config.name);

  // Insert UserApp records with custom metadata for known apps
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

  console.log(chalk.green("Deployment successful!\n"));

  const gatewayUrlFromDeployment = await getWorkerUrl("every-app-gateway");
  console.log(
    `Try it out in your gateway: ${chalk.cyan(gatewayUrlFromDeployment)}\n`,
  );
}
