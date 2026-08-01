import type { LocalContext } from "@/context";
import chalk from "chalk";
import { requireCloudflareAuth } from "@/lib/cloudflare";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
import { setupLocalEnvironment } from "@/commands/app/shared/setupLocalEnvironment";
import {
  ensureGeneratedWranglerConfig,
  loadEveryAppManifest,
} from "@/lib/generateWranglerConfig";

interface SetupLocalCommandFlags {
  verbose?: boolean;
}

/**
 * Main setup-local command implementation.
 */
export async function setupLocal(
  this: LocalContext,
  flags: SetupLocalCommandFlags,
): Promise<void> {
  const cwd = process.cwd();
  const verbose = flags.verbose || false;

  // Check we're inside an Every App project
  await checkIsEveryAppProject();

  await requireCloudflareAuth();

  // Check gateway is deployed and has an owner account before proceeding
  const gatewayUrl = await requireGatewaySetup();

  const manifest = await loadEveryAppManifest(cwd);
  const appId = manifest.id;
  await ensureGeneratedWranglerConfig(cwd, { manifest });

  console.log(chalk.bold(`\nSetting up local environment for ${appId}\n`));

  await setupLocalEnvironment({
    targetDir: cwd,
    appId,
    gatewayUrl,
    verbose,
    installDeps: true,
    migrations: manifest.migrations,
  });

  console.log(chalk.green("Local setup complete!\n"));
  console.log("Run the app locally:\n");
  console.log(chalk.dim(`  ${chalk.bold("pnpm run dev")}\n`));
}
