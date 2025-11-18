import chalk from "chalk";

/**
 * Print next steps for the user after successful project creation
 */
export function printNextSteps(
  appId: string,
  targetDir: string,
  gatewayUrl: string,
): void {
  console.log(chalk.green("🎉 Project created successfully!\n"));
  console.log(chalk.dim(`Location: ${targetDir}\n`));
  console.log("Next steps:\n");
  console.log(chalk.dim(`  1. ${chalk.bold(chalk.italic(`cd ${appId}`))}`));
  console.log(chalk.dim(`  2. ${chalk.bold(chalk.italic(`pnpm run dev`))}`));
  console.log(
    chalk.dim(
      `  3. Click "Add App" in your gateway: ${chalk.reset(chalk.cyan(gatewayUrl))}`,
    ),
  );
  console.log(chalk.dim("  4. Configure App"));
  console.log(
    chalk.dim(`    - App ID: ${chalk.bold(chalk.italic(`${appId}`))}`),
  );
  console.log(
    chalk.dim(
      `    - App URL: ${chalk.bold(chalk.italic(`http://localhost:3001`))} (or whatever your dev url is)`,
    ),
  );
  console.log(
    chalk.dim("  5. Click the app in the gateway and start building\n"),
  );
  console.log("Deploy to production:\n");
  console.log(
    chalk.dim(
      chalk.bold(
        chalk.italic(
          `   every app deploy	    # Spin up KV Store, run migrations on prod db, deploy app to Cloudflare Workers.`,
        ),
      ),
    ),
  );
  console.log(
    chalk.dim(
      chalk.bold(
        chalk.italic(`   pnpm run deploy          # Deploy to Cloudflare\n`),
      ),
    ),
  );
}
