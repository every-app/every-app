import chalk from "chalk";

interface PrintNextStepsOptions {
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  targetDir: string;
  gatewayUrl: string;
  liveUrl: string;
}

/**
 * Print next steps for the user after successful project creation and deployment
 */
export function printNextSteps({
  appId,
  targetDir,
  gatewayUrl,
  liveUrl,
}: PrintNextStepsOptions): void {
  console.log(chalk.green("Project created and deployed successfully!\n"));
  console.log(chalk.dim(`  Location: ${targetDir}`));
  console.log(chalk.dim(`  App URL:  ${chalk.cyan(liveUrl)}`));
  console.log(chalk.dim(`  Gateway:  ${chalk.cyan(gatewayUrl)}`));
  console.log(chalk.dim("  Routed through the gateway service binding."));
  console.log();
  console.log("For local development:\n");
  console.log(chalk.dim(`  ${chalk.bold(`cd ${appId}`)}`));
  console.log(chalk.dim(`  ${chalk.bold(`pnpm run dev`)}`));
  console.log(
    chalk.dim(
      `  ${chalk.bold(`\n  Then, open the local dev URL printed by everyapp dev.`)}`,
    ),
  );
  console.log();
  console.log("To deploy updates after changes:\n");
  console.log(chalk.dim(`  ${chalk.bold("npx everyapp app deploy")}`));
  console.log();
}
