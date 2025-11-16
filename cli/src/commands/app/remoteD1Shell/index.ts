import type { LocalContext } from "@/context";
import chalk from "chalk";
import { execa } from "execa";
import { getDefaultAccountId, getValidOAuthToken } from "@/lib/cloudflare-auth";
import { listD1Databases } from "@/lib/cloudflare-d1";
import { readWranglerConfig } from "@/lib/wrangler-config";

interface D1DatabaseConfig {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir?: string;
}

/**
 * Remote D1 shell command implementation
 * Sets environment variables needed for connecting to D1 and runs a command
 */
export async function remoteD1Shell(
  this: LocalContext,
  _flags: Record<string, never>,
  ...command: string[]
): Promise<void> {
  const cwd = process.cwd();

  try {
    // Validate that a command was provided
    if (!command || command.length === 0) {
      throw new Error(
        "No command provided. Usage: every app remote-d1-shell -- <command>\nExample: every app remote-d1-shell -- npx drizzle-kit migrate",
      );
    }

    const [cmd, ...cmdArgs] = command;
    if (!cmd) {
      throw new Error("Invalid command");
    }

    // Read wrangler.jsonc to get database_name
    const config = await readWranglerConfig(cwd);

    if (!config.d1_databases || config.d1_databases.length === 0) {
      throw new Error(
        "No D1 databases found in wrangler.jsonc. Please add a D1 database configuration.",
      );
    }

    // Get the first D1 database configuration
    const d1Config = config.d1_databases[0] as D1DatabaseConfig;
    const databaseName = d1Config.database_name;

    if (!databaseName) {
      throw new Error(
        "No database_name found in D1 database configuration in wrangler.jsonc.",
      );
    }

    console.log("Retrieving shell info from Cloudflare...");
    const [accountId, databases, token] = await Promise.all([
      getDefaultAccountId(),
      listD1Databases(),
      getValidOAuthToken(),
    ]);

    // Get database ID by looking up the database with matching name
    const database = databases.find((db: any) => db.name === databaseName);

    if (!database) {
      throw new Error(
        `Database "${databaseName}" not found in your Cloudflare account. Have you run \`every app deploy\` to create the database?`,
      );
    }

    const databaseId = database.uuid;

    // Run the command with environment variables
    console.log(
      chalk.bold(`\nRunning: ${chalk.cyan([cmd, ...cmdArgs].join(" "))}\n`),
    );

    await execa(cmd, cmdArgs, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        CLOUDFLARE_DATABASE_ID: databaseId,
        CLOUDFLARE_API_TOKEN: token,
      },
    });

    console.log("\nCommand executed!");
  } catch (error) {
    console.error(
      chalk.red("\nFailed to generate shell configuration:"),
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}
