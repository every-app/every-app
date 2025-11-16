import type { LocalContext } from "@/context";
import fs from "node:fs/promises";
import path from "node:path";
import enquirer from "enquirer";
import { execa } from "execa";
import chalk from "chalk";
import { cloneRepository } from "@/lib/git";
import {
  type PackageManager,
  installDependencies,
} from "@/lib/package-manager";
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

interface CreateCommandFlags {
  // Add flags here as needed
}

const EVERY_APP_REPO = "git@github.com:every-app/every-app.git";
const TEMPLATE_RELATIVE_PATH = "templates/simple-todo";

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
    initial: "my-cool-app",
    validate: validateAppId,
  });

  return response.appId;
}

/**
 * Prompt user for package manager
 */
async function promptPackageManager(): Promise<PackageManager> {
  const response = await enquirer.prompt<{ packageManager: PackageManager }>({
    type: "select",
    name: "packageManager",
    message: "Select your package manager",
    choices: [
      { name: "pnpm", message: "pnpm (recommended)" },
      { name: "npm", message: "npm" },
    ],
    initial: 0,
  });

  return response.packageManager;
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

  // Update migration commands to use the new app ID
  packageJson.scripts["db:migrate:dev"] =
    `wrangler d1 migrations apply ${appId} --local`;
  packageJson.scripts["db:migrate:prod"] =
    `wrangler d1 migrations apply ${appId} --remote`;

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
  appId: string,
): Promise<void> {
  try {
    await execa(
      "npx",
      ["wrangler", "d1", "migrations", "apply", appId, "--local"],
      {
        cwd: targetDir,
        input: "y\n",
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    console.log(
      chalk.green("\nLocal database migrations completed successfully\n"),
    );
  } catch (error) {
    console.warn(
      chalk.yellow(
        "\nFailed to run local migrations. You can run them manually with:",
      ),
    );
    console.warn(chalk.dim("   npm run db:migrate:dev\n"));
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
  console.log(chalk.bold("\nCreate a new Every App project\n"));

  let tempDir: string | null = null;

  try {
    // Phase 1: User Input
    console.log(chalk.bold("Project Configuration\n"));
    const appId = await promptAppId();
    const packageManager = await promptPackageManager();

    console.log(chalk.dim(`\nCreating project: ${appId}`));
    console.log(chalk.dim(`Package manager: ${packageManager}\n`));

    // Phase 2: Repository Cloning
    console.log(chalk.bold("Cloning template repository...\n"));
    tempDir = await createTempDirectory("every-app-create-");
    await cloneRepository(EVERY_APP_REPO, tempDir);

    // Phase 3: Template Extraction & Copy
    console.log(chalk.bold("\nExtracting template...\n"));
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

    console.log(chalk.green(`Template copied to ${targetDir}\n`));

    // Phase 4: Cloudflare Resources Creation
    console.log(chalk.bold("Creating Cloudflare resources...\n"));
    const d1DatabaseId = await getOrCreateD1Database(appId);
    const kvNamespaceId = await getOrCreateKVNamespace(appId);

    console.log(chalk.green("Cloudflare resources ready:\n"));
    console.log(chalk.dim(`   D1 Database: ${appId} (${d1DatabaseId})`));
    console.log(chalk.dim(`   KV Namespace: ${appId} (${kvNamespaceId})\n`));

    // Phase 5: Configuration Updates
    console.log(chalk.bold("Updating configuration files...\n"));
    const wranglerPath = path.join(targetDir, "wrangler.jsonc");
    await updateWranglerConfig(wranglerPath, {
      name: appId,
      d1DatabaseId,
      d1DatabaseName: appId,
      kvNamespaceId,
    });
    await updatePackageJson(targetDir, appId);
    await createEnvFiles(targetDir, appId);
    console.log(chalk.green("Configuration updated\n"));

    // Phase 6: Install Dependencies
    console.log(
      chalk.bold(`Installing dependencies with ${packageManager}...\n`),
    );
    await installDependencies(packageManager, targetDir);
    console.log(chalk.green("\nDependencies installed\n"));

    // Phase 7: Run Migrations (LOCAL)
    console.log(chalk.bold("Running database migrations locally...\n"));
    await runLocalMigrations(targetDir, appId);

    // Phase 8: Success Message
    console.log(chalk.bold.green("\nProject created successfully!\n"));
    console.log(chalk.dim(`Location: ${targetDir}\n`));
    console.log(chalk.bold("Next steps:\n"));
    console.log(chalk.cyan(`  1. cd ${appId}`));
    console.log(chalk.cyan(`  2. ${packageManager} run dev`));
    console.log(chalk.cyan("  3. Open your browser and start building!\n"));
    console.log(chalk.bold("Deploy to production:\n"));
    console.log(
      chalk.dim(
        `   ${packageManager} run db:migrate:prod  # Run remote migrations`,
      ),
    );
    console.log(
      chalk.dim(`   npm run deploy          # Deploy to Cloudflare\n`),
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
