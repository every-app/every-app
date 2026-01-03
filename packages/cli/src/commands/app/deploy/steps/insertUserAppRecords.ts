import chalk from "chalk";
import {
  getGatewayDatabase,
  getAllUsers,
  upsertUserApp,
  type User,
  type GatewayDbConnection,
} from "@/lib/gateway-db";

/**
 * Options for inserting user app records
 */
interface InsertUserAppOptions {
  appId: string;
  appUrl: string;
  verbose?: boolean;
  appName?: string;
  appDescription?: string;
  devUrl?: string;
}

/**
 * Insert UserApp records for the deployed app
 * This is specific to the app deploy command - it creates records in the
 * every-app-gateway database to register the app for users
 */
export async function insertUserAppRecords(
  options: InsertUserAppOptions,
): Promise<void> {
  const {
    appId,
    appUrl,
    verbose = false,
    appName,
    appDescription,
    devUrl,
  } = options;

  try {
    console.log("");
    if (verbose) console.log("Adding apps to user gateways...");

    const db = await getGatewayDatabase();
    if (!db) {
      console.warn(
        chalk.yellow(
          "every-app-gateway database not found. Skipping UserApp record creation.\n",
        ),
      );
      return;
    }

    const users = await getAllUsers(db);
    if (users.length === 0) {
      throw new Error(
        "No users found in the database. Please create a user first before deploying apps.",
      );
    }

    const displayName = appName || appId;
    const displayDescription = appDescription || appId;

    if (verbose && users.length > 1) {
      console.log(
        chalk.yellow(
          `Multiple users found (${users.length}). Adding app to all users...\n`,
        ),
      );
    }

    for (const user of users) {
      await processUserAppRecord(db, user, {
        appId,
        appUrl,
        name: displayName,
        description: displayDescription,
        devUrl,
        verbose,
      });
    }

    if (verbose && users.length > 1) {
      console.log(`  UserApp records processed for ${users.length} users\n`);
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
 * Process a single user's app record with logging
 */
async function processUserAppRecord(
  db: GatewayDbConnection,
  user: User,
  options: {
    appId: string;
    appUrl: string;
    name: string;
    description: string;
    devUrl?: string;
    verbose: boolean;
  },
): Promise<void> {
  const { verbose, ...upsertOptions } = options;

  const result = await upsertUserApp(db, user, upsertOptions);

  if (result.created) {
    console.log(
      `  UserApp record created for user ${user.name} (${user.email})`,
    );
  } else if (verbose) {
    console.log(
      chalk.dim(
        `  UserApp record already exists for user ${user.name} (${user.email})`,
      ),
    );
  }
}
