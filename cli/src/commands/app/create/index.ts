import type { LocalContext } from "@/context";
import fs from "node:fs/promises";
import path from "node:path";
import enquirer from "enquirer";
import chalk from "chalk";
import { execa } from "execa";
import { cloneRepository } from "@/lib/git";
import { installDependencies } from "@/lib/package-manager";
import {
  copyDirectory,
  directoryExists,
  createEnvFiles,
  createTempDirectory,
  cleanupTempDirectory,
} from "@/lib/file-operations";
import { updateWranglerConfig } from "@/lib/wrangler-config";
import { getOrCreateD1Database } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";
import { executeCommandWithFormatting } from "@/lib/formatting";
import { getWorkerUrl } from "@/lib/cloudflare-auth";

interface CreateCommandFlags {
  verbose?: boolean;
}

const EVERY_APP_REPO = "git@github.com:every-app/every-app.git";
const TEMPLATE_RELATIVE_PATH = "templates/simple-todo";

/**
 * Check if pnpm is installed
 */
async function checkPnpmInstalled(): Promise<boolean> {
  try {
    await execa("pnpm", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate app ID format (kebab-case)
 */
function validateAppId(input: string): boolean | string {
  if (!input || input.trim().length === 0) {
    return "App ID cannot be empty";
  }

  if (input.length > 64) {
    return "App ID must be 64 characters or less";
  }

  // Allow lowercase letters, numbers, and hyphens
  // Must start with a letter
  const kebabCaseRegex = /^[a-z][a-z0-9-]*$/;

  if (!kebabCaseRegex.test(input)) {
    return "App ID must be in kebab-case format (lowercase letters, numbers, and hyphens only, starting with a letter)";
  }

  return true;
}

/**
 * Prompt user for app ID
 */
async function promptAppId(): Promise<string> {
  const response = await enquirer.prompt<{ appId: string }>({
    type: "input",
    name: "appId",
    message: "Enter your app ID (kebab-case format)",
    validate: validateAppId,
  });

  return response.appId;
}

/**
 * Prompt user to acknowledge pnpm requirement
 * Loops until user confirms with 'y'
 */
async function promptPnpmAcknowledgement(): Promise<void> {
  let acknowledged = false;
  let response = null;

  while (!acknowledged) {
    response = await enquirer.prompt<{ acknowledged: boolean }>({
      type: "confirm",
      name: "acknowledged",
      message: !response
        ? "pnpm has been chosen as the package manager for Every App projects. Other package managers will not work with `every app deploy` currently.\n\n  Press y to acknowledge this."
        : "You must acknowledge this to proceed. Press y to continue.\n",
      initial: false,
    });

    if (response.acknowledged) {
      acknowledged = true;
    } else {
      // Add a new line for console log formatting.
      console.log();
    }
  }
}

/**
 * Update package.json with app ID
 */
async function updatePackageJson(
  targetDir: string,
  appId: string,
): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  // Update name
  packageJson.name = appId;

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Run database migrations locally
 */
async function runLocalMigrations(
  targetDir: string,
  verbose: boolean,
): Promise<void> {
  try {
    // Generate Cloudflare types and build the project
    // This creates the .wrangler directory which is necessary for running migrations locally
    if (!verbose) {
      console.log("\nSetting up Cloudflare for local dev...");
    }

    await executeCommandWithFormatting("pnpm", ["run", "cf-typegen"], {
      cwd: targetDir,
      verbose,
      logCommandToConsole: false,
    });

    await executeCommandWithFormatting("pnpm", ["run", "build"], {
      cwd: targetDir,
      verbose,
      logCommandToConsole: false,
    });
    if (!verbose) console.log(chalk.dim("  Finished.\n"));

    await executeCommandWithFormatting("pnpm", ["run", "db:migrate:local"], {
      cwd: targetDir,
      verbose,
    });

    console.log("\nLocal database migrations complete.\n");
  } catch (error) {
    console.warn(
      chalk.yellow(
        "\nFailed to run local migrations. You can run them manually with:",
      ),
    );
    console.warn(chalk.dim("   pnpm run db:migrate:local\n"));
    // Don't throw - this is not a fatal error for project creation
  }
}

/**
 * Main create command implementation
 */
export default async function (
  this: LocalContext,
  flags: CreateCommandFlags,
): Promise<void> {
  const verbose = flags.verbose || false;

  // Check for pnpm before any prompts
  const hasPnpm = await checkPnpmInstalled();
  if (!hasPnpm) {
    console.error(
      chalk.red(
        "\nError: pnpm is required but not installed. Please install it first:",
      ),
    );
    console.error(chalk.cyan("  npm i -g pnpm\n"));
    process.exit(1);
  }

  console.log("\nCreate a new Every App project\n");

  let tempDir: string | null = null;

  try {
    // Phase 1: User Input
    console.log("Project Configuration\n");
    const appId = await promptAppId();
    console.log();
    await promptPnpmAcknowledgement();

    // Phase 2: Repository Cloning
    if (verbose) {
      console.log("Cloning template repository...\n");
    }
    tempDir = await createTempDirectory("every-app-create-");
    await cloneRepository(EVERY_APP_REPO, tempDir, verbose);

    // Phase 3: Template Extraction & Copy
    if (verbose) {
      console.log("Extracting template...\n");
    }
    const templatePath = path.join(tempDir, TEMPLATE_RELATIVE_PATH);
    const targetDir = path.join(process.cwd(), appId);

    // Check if directory already exists
    if (await directoryExists(targetDir)) {
      throw new Error(
        `Directory "${appId}" already exists in the current location`,
      );
    }

    await copyDirectory(templatePath, targetDir, {
      exclude: [
        "node_modules",
        ".git",
        "pnpm-lock.yaml",
        "package-lock.json",
        ".env.local",
        ".env.production",
        ".dev.vars",
        "manual-steps.md",
      ],
    });

    if (verbose) {
      console.log(chalk.dim(`  Template copied to ${targetDir}\n`));
    }

    // Phase 4: Cloudflare Resources Creation
    if (!verbose) {
      console.log("\nCreating Cloudflare resources...\n");
    } else {
      console.log("Creating Cloudflare resources...\n");
    }
    const d1DatabaseId = await getOrCreateD1Database(appId, verbose);
    const kvNamespaceId = await getOrCreateKVNamespace(appId, verbose);

    if (verbose) {
      console.log("Cloudflare resources ready:\n");
      console.log(chalk.dim(`   D1 Database: ${appId} (${d1DatabaseId})`));
      console.log(chalk.dim(`   KV Namespace: ${appId} (${kvNamespaceId})\n`));
    }

    // Phase 5: Configuration Updates
    if (verbose) {
      console.log("Updating configuration files...\n");
    }
    const wranglerPath = path.join(targetDir, "wrangler.jsonc");
    await updateWranglerConfig({
      configPath: wranglerPath,
      name: appId,
      d1DatabaseId: d1DatabaseId,
      d1DatabaseName: appId,
      kvNamespaceId: kvNamespaceId,
      verbose,
    });
    await updatePackageJson(targetDir, appId);
    await createEnvFiles(targetDir, appId);
    if (verbose) {
      console.log(chalk.dim("  Configuration updated"));
    }

    // Phase 6: Install Dependencies
    console.log();
    await installDependencies(
      targetDir,
      "Installing dependencies for local dev...",
      verbose,
    );

    // Phase 7: Run Migrations (LOCAL)
    await runLocalMigrations(targetDir, verbose);

    // Phase 8: Success Message
    console.log(chalk.green("🎉 Project created successfully!\n"));
    console.log(chalk.dim(`Location: ${targetDir}\n`));
    console.log("Next steps:\n");
    console.log(chalk.dim(`  1. ${chalk.bold(chalk.italic(`cd ${appId}`))}`));
    console.log(chalk.dim(`  2. ${chalk.bold(chalk.italic(`pnpm run dev`))}`));

    // Try to get the actual gateway URL from Cloudflare
    const gatewayUrl = await getWorkerUrl("every-app-gateway");

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
  } catch (error) {
    console.error(
      chalk.red("\nFailed to create project:"),
      error instanceof Error ? error.message : "Unknown error",
    );
    throw error;
  } finally {
    // Cleanup temp directory
    if (tempDir) {
      await cleanupTempDirectory(tempDir);
    }
  }
}
