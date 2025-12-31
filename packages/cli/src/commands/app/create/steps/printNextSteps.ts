import chalk from "chalk";

/**
 * Print next steps for the user after successful project creation and deployment
 */
export function printNextSteps(
  appId: string,
  targetDir: string,
  gatewayUrl: string,
  workerUrl: string,
): void {
  console.log(chalk.green("Project created and deployed successfully!\n"));
  console.log(chalk.dim(`  Location: ${targetDir}`));
  console.log(chalk.dim(`  App URL:  ${chalk.cyan(workerUrl)}`));
  console.log(chalk.dim(`  Gateway:  ${chalk.cyan(gatewayUrl)}`));
  console.log();
  console.log("For local development:\n");
  console.log(chalk.dim(`  ${chalk.bold(`cd ${appId}`)}`));
  console.log(chalk.dim(`  ${chalk.bold(`pnpm run dev`)}`));
  console.log(
    chalk.dim(
      `  ${chalk.bold(`\n  Then, go to the Gateway and click the "Dev" button on the app to go to the app running locally instead of on cloudflare.`)}`,
    ),
  );
  console.log();
  console.log("To deploy updates after changes:\n");
  console.log(chalk.dim(`  ${chalk.bold("npx @every-app/cli app deploy")}`));
  console.log();
}
