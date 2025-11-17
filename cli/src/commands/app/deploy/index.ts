import type { LocalContext } from "@/context";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs/promises";
import { execa } from "execa";
import * as jsonc from "jsonc-parser";
import { getOrCreateD1Database, listD1Databases } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";
import { type WranglerConfig, readWranglerConfig } from "@/lib/wrangler-config";
import {
  getWorkerUrl,
  getDefaultAccountId,
  getValidOAuthToken,
} from "@/lib/cloudflare-auth";
import { execWithIndentedOutput } from "@/lib/formatting";
import { confirmDeployment } from "@/lib/deployment";
import { ensureDependencies } from "@/lib/package-manager";
import { randomUUID } from "node:crypto";

interface DeployCommandFlags {
  verbose?: boolean;
}

interface D1DatabaseConfig {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir?: string;
}

interface KVNamespaceConfig {
  binding: string;
  id?: string;
}

/**
 * Set up Cloudflare resources based on wrangler.jsonc
 */
async function setupCloudflareResources(
  config: WranglerConfig,
  workerName: string,
): Promise<{ d1Updates: Map<number, string>; kvUpdates: Map<number, string> }> {
  console.log(chalk.bold("\nSetting up Cloudflare resources...\n"));

  const d1Updates = new Map<number, string>();
  const kvUpdates = new Map<number, string>();

  // Handle D1 databases
  if (config.d1_databases && config.d1_databases.length > 0) {
    console.log(chalk.bold("Processing D1 databases...\n"));

    for (let i = 0; i < config.d1_databases.length; i++) {
      const db = config.d1_databases[i] as D1DatabaseConfig;
      const databaseName = db.database_name;

      if (!databaseName) {
        console.warn(
          chalk.yellow(
            `Skipping D1 database at index ${i}: no database_name specified\n`,
          ),
        );
        continue;
      }

      const databaseId = await getOrCreateD1Database(databaseName);
      d1Updates.set(i, databaseId);
    }
  }

  // Handle KV namespaces
  if (config.kv_namespaces && config.kv_namespaces.length > 0) {
    console.log(chalk.bold("Processing KV namespaces...\n"));

    for (let i = 0; i < config.kv_namespaces.length; i++) {
      const kv = config.kv_namespaces[i] as KVNamespaceConfig;

      if (!kv.binding) {
        console.warn(
          chalk.yellow(
            `Skipping KV namespace at index ${i}: no binding specified\n`,
          ),
        );
        continue;
      }

      // Use worker name for KV namespace
      const namespaceId = await getOrCreateKVNamespace(workerName);
      kvUpdates.set(i, namespaceId);
    }
  }

  return { d1Updates, kvUpdates };
}

/**
 * Update wrangler.jsonc with resource IDs and gateway URL
 */
async function updateConfigWithResources(
  cwd: string,
  d1Updates: Map<number, string>,
  kvUpdates: Map<number, string>,
  gatewayUrl: string,
): Promise<void> {
  console.log(chalk.bold("Updating wrangler.jsonc with resource IDs...\n"));

  const wranglerPath = path.join(cwd, "wrangler.jsonc");
  const configContent = await fs.readFile(wranglerPath, "utf-8");
  let edits: jsonc.Edit[] = [];

  // Update D1 database IDs
  for (const [index, databaseId] of d1Updates.entries()) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["d1_databases", index, "database_id"],
        databaseId,
        {},
      ),
    );
  }

  // Update KV namespace IDs
  for (const [index, namespaceId] of kvUpdates.entries()) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["kv_namespaces", index, "id"],
        namespaceId,
        {},
      ),
    );
  }

  // Update CORE_APP_URL if gatewayUrl is provided
  edits.push(
    ...jsonc.modify(configContent, ["vars", "CORE_APP_URL"], gatewayUrl, {}),
  );

  const updatedContent = jsonc.applyEdits(configContent, edits);
  await fs.writeFile(wranglerPath, updatedContent);

  console.log(chalk.green("wrangler.jsonc updated successfully\n"));
}

/**
 * Run database migrations
 */
async function runMigrations(
  cwd: string,
  config: WranglerConfig,
): Promise<void> {
  if (!config.d1_databases || config.d1_databases.length === 0) {
    console.log(chalk.dim("No D1 databases configured, skipping migrations\n"));
    return;
  }

  console.log(chalk.bold("Running database migrations...\n"));

  try {
    console.log(chalk.dim(`   Running production migrations...\n`));

    await execa("npm", ["run", "db:migrate:prod"], {
      cwd,
      stdio: ["inherit", "inherit", "inherit"],
    });

    console.log(chalk.green(`Migrations completed\n`));
  } catch (error) {
    console.warn(
      chalk.yellow(
        `Failed to run migrations. You may need to run them manually with: npm run db:migrate:prod\n`,
      ),
    );
    // Don't throw - continue with deployment
  }
}

/**
 * Build and deploy the app
 */
async function buildAndDeploy(
  cwd: string,
  gatewayUrl: string,
  appId: string,
  verbose: boolean,
): Promise<void> {
  console.log(chalk.bold("Building and deploying to Cloudflare...\n"));

  try {
    // Check if there's a deploy script in package.json
    const packageJsonPath = path.join(cwd, "package.json");
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

    const deployEnv = {
      ...process.env,
      VITE_PARENT_ORIGIN: gatewayUrl,
      VITE_APP_ID: appId,
    };

    if (packageJson.scripts?.deploy) {
      await execWithIndentedOutput("npm", ["run", "deploy"], {
        cwd,
        stdio: "inherit",
        env: deployEnv,
        verbose,
      });
    } else {
      // Fallback to basic build and deploy
      await execWithIndentedOutput("npm", ["run", "build"], {
        cwd,
        stdio: "inherit",
        env: deployEnv,
        verbose,
      });

      await execWithIndentedOutput("npx", ["wrangler", "deploy"], {
        cwd,
        stdio: "inherit",
        env: deployEnv,
        verbose,
      });
    }

    console.log(chalk.green("\nDeployment completed successfully!\n"));
  } catch (error) {
    console.error(chalk.red("\nFailed to build or deploy"));
    throw error;
  }
}

/**
 * Query a D1 database using the HTTP API
 */
async function queryD1Database<T = any>(
  accountId: string,
  databaseId: string,
  sql: string,
): Promise<T[]> {
  interface D1QueryResponse {
    results: T[];
    success: boolean;
    meta: {
      duration: number;
      rows_read: number;
      rows_written: number;
    };
  }

  interface D1APIResponse {
    success: boolean;
    errors: Array<{ code: number; message: string }>;
    messages: string[];
    result: D1QueryResponse[];
  }

  try {
    const accessToken = await getValidOAuthToken();

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql }),
      },
    );

    const data = (await response.json()) as D1APIResponse;

    if (!response.ok || !data.success) {
      const errorDetails = data.errors
        ? data.errors.map((e) => `[${e.code}] ${e.message}`).join(", ")
        : response.statusText;
      console.error(chalk.red("\nD1 Query Error:"));
      console.error(chalk.dim(`SQL: ${sql}`));
      console.error(chalk.dim(`Error: ${errorDetails}`));
      throw new Error(`D1 query failed: ${errorDetails}`);
    }

    const result = data.result;
    if (!result || result.length === 0) {
      throw new Error("No results returned from D1 query");
    }

    const firstResult = result[0];
    if (!firstResult) {
      throw new Error("First result is undefined");
    }

    return firstResult.results;
  } catch (error) {
    if (error instanceof Error && !error.message.includes("D1 query failed")) {
      console.error(chalk.red("\nD1 Query Error:"));
      console.error(chalk.dim(`SQL: ${sql}`));
    }
    throw error;
  }
}

/**
 * Insert UserApp records for the deployed app
 */
async function insertUserAppRecords(
  appId: string,
  appUrl: string,
  appName?: string,
  appDescription?: string,
): Promise<void> {
  console.log(chalk.bold("\nSetting up UserApp records...\n"));

  try {
    // Get account ID
    const accountId = await getDefaultAccountId();

    // Get every-app-gateway database ID
    const databases = await listD1Databases();
    const gatewayDb = databases.find(
      (db: any) => db.name === "every-app-gateway",
    );

    if (!gatewayDb) {
      console.warn(
        chalk.yellow(
          "every-app-gateway database not found. Skipping UserApp record creation.\n",
        ),
      );
      return;
    }

    const databaseId = gatewayDb.uuid;

    // Query users from the database
    interface User {
      id: string;
      name: string;
      email: string;
    }

    const users = await queryD1Database<User>(
      accountId,
      databaseId,
      "SELECT id, name, email FROM users",
    );

    // Handle different user count scenarios
    if (users.length === 0) {
      throw new Error(
        "No users found in the database. Please create a user first before deploying apps.",
      );
    }

    // Use provided name/description or fall back to appId
    const displayName = appName || appId;
    const displayDescription = appDescription || appId;

    if (users.length === 1) {
      // Insert for single user if not already exists
      const user = users[0] as User;
      const now = Math.floor(Date.now() / 1000);

      // Check if record already exists
      const existingRecords = await queryD1Database<{ id: string }>(
        accountId,
        databaseId,
        `SELECT id FROM user_apps WHERE user_id = '${user.id}' AND app_id = '${appId}'`,
      );

      if (existingRecords.length > 0) {
        // Skip - record already exists
        console.log(
          chalk.yellow(
            `UserApp record already exists for user ${user.name} (${user.email}), skipping...\n`,
          ),
        );
      } else {
        // Insert new record
        const recordId = randomUUID();
        const insertSql = `
          INSERT INTO user_apps (id, user_id, app_id, name, description, app_url, created_at, updated_at)
          VALUES ('${recordId}', '${user.id}', '${appId}', '${displayName}', '${displayDescription}', '${appUrl}', ${now}, ${now})
        `;
        await queryD1Database(accountId, databaseId, insertSql);
        console.log(
          chalk.green(
            `UserApp record created for user ${user.name} (${user.email})\n`,
          ),
        );
      }
    } else {
      // TODO: In the future, we should prompt the user to select which user(s) to add the app to
      // For now, add to all users
      console.log(
        chalk.yellow(
          `Multiple users found (${users.length}). Adding app to all users...\n`,
        ),
      );

      for (const user of users) {
        const now = Math.floor(Date.now() / 1000);

        // Check if record already exists
        const existingRecords = await queryD1Database<{ id: string }>(
          accountId,
          databaseId,
          `SELECT id FROM user_apps WHERE user_id = '${user.id}' AND app_id = '${appId}'`,
        );

        if (existingRecords.length > 0) {
          // Skip - record already exists
          console.log(
            chalk.dim(
              `   App already exists for user ${user.name} (${user.email}), skipping...\n`,
            ),
          );
        } else {
          // Insert new record
          const recordId = randomUUID();
          const insertSql = `
            INSERT INTO user_apps (id, user_id, app_id, name, description, app_url, created_at, updated_at)
            VALUES ('${recordId}', '${user.id}', '${appId}', '${displayName}', '${displayDescription}', '${appUrl}', ${now}, ${now})
          `;
          await queryD1Database(accountId, databaseId, insertSql);
          console.log(
            chalk.dim(`   Added app for user ${user.name} (${user.email})\n`),
          );
        }
      }

      console.log(
        chalk.green(`UserApp records processed for ${users.length} users\n`),
      );
    }
  } catch (error) {
    console.error(
      chalk.red("Failed to insert UserApp records:"),
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

/**
 * Core app deployment logic that can be called from other commands
 * @param cwd - The directory containing the app to deploy
 * @param skipConfirmation - Whether to skip the deployment confirmation prompt
 * @param verbose - Whether to show verbose output
 */
async function deployAppFromDirectory(
  cwd: string,
  skipConfirmation: boolean = false,
  verbose: boolean = false,
): Promise<void> {
  try {
    // Step 1: Read wrangler.jsonc
    console.log(chalk.bold("\nReading project configuration...\n"));
    const config = await readWranglerConfig(cwd);

    if (!config.name) {
      throw new Error(
        "Worker name not found in wrangler.jsonc. Please add a 'name' field.",
      );
    }

    const workerName = config.name;
    console.log(chalk.dim(`Project name: ${workerName}\n`));

    // Step 2: Confirm deployment (if not skipped)
    if (!skipConfirmation) {
      const confirmed = await confirmDeployment(
        "Do you want to deploy this app to Cloudflare?",
      );
      if (!confirmed) {
        console.log(chalk.red("\nDeployment cancelled by user\n"));
        return;
      }
    }

    // Step 3: Set up Cloudflare resources
    const { d1Updates, kvUpdates } = await setupCloudflareResources(
      config,
      workerName,
    );

    const gatewayUrl = await getWorkerUrl("every-app-gateway");

    // Step 4: Update wrangler.jsonc with resource IDs and gateway URL
    await updateConfigWithResources(cwd, d1Updates, kvUpdates, gatewayUrl);

    // Step 5: Ensure dependencies are installed
    await ensureDependencies(cwd, verbose);

    // Step 6: Run migrations
    await runMigrations(cwd, config);

    // Step 7: Build and deploy with app ID and gateway URL
    await buildAndDeploy(cwd, gatewayUrl, workerName, verbose);

    // Step 8: Get and display worker URL
    const workerUrl = await getWorkerUrl(config.name);

    // Step 10: Insert UserApp records with custom metadata for known apps
    let appName: string | undefined;
    let appDescription: string | undefined;

    // Special handling for todo-app
    if (config.name === "every-todo-app") {
      appName = "Todos";
      appDescription = "Minimal todo list";
    }

    await insertUserAppRecords(config.name, workerUrl, appName, appDescription);

    console.log(chalk.bold.green("🎉 Deployment successful!\n"));
    console.log(
      chalk.bold(`Your app is now live at: ${chalk.cyan(workerUrl)}\n`),
    );
    console.log(
      chalk.dim("Try it out by visiting the URL above in your browser.\n"),
    );
  } catch (error) {
    console.error(
      chalk.red("\nDeployment failed:"),
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
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
  await deployAppFromDirectory(cwd, false, verbose);
}
