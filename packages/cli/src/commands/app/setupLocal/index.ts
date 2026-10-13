import type { LocalContext } from "@/context";
import chalk from "chalk";
import { requireGatewaySetup } from "@/lib/gateway";
import { checkIsEveryAppProject } from "@/commands/app/deploy/steps/checkIsEveryAppProject";
import { setupLocalEnvironment } from "@/commands/app/shared/setupLocalEnvironment";
import { loadEveryAppManifest } from "@/lib/manifest";

interface SetupLocalCommandFlags {
  gateway?: string;
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

  // Check gateway is deployed and has an owner account before proceeding
  const gatewayUrl = await requireGatewaySetup(flags.gateway);

  const manifest = await loadEveryAppManifest(cwd);

  console.log(
    chalk.bold(`\nSetting up local environment for ${manifest.id}\n`),
  );

  await setupLocalEnvironment({
    targetDir: cwd,
    manifest,
    gatewayUrl,
    verbose,
    installDeps: true,
  });

  console.log(chalk.green("Local setup complete!\n"));
  console.log("Run the app locally:\n");
  console.log(chalk.dim(`  ${chalk.bold("pnpm run dev")}\n`));
}
