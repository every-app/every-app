import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { getDefaultAccountId } from "@/lib/cloudflare-auth";
import { listD1Databases } from "@/lib/cloudflare-d1";
import { queryD1Database } from "@/lib/cloudflare-d1-queries";

interface User {
  id: string;
  name: string;
  email: string;
}

/**
 * Insert UserApp records for the deployed app
 * This is specific to the app deploy command - it creates records in the
 * every-app-gateway database to register the app for users
 */
export async function insertUserAppRecords(
  appId: string,
  appUrl: string,
  verbose: boolean = false,
  appName?: string,
  appDescription?: string,
): Promise<void> {
  try {
    if (verbose) console.log("Adding apps to user gateways...");
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
      await insertUserAppRecord(
        accountId,
        databaseId,
        users[0] as User,
        appId,
        appUrl,
        displayName,
        displayDescription,
        verbose,
      );
    } else {
      // Multiple users - add to all
      if (verbose) {
        console.log(
          chalk.yellow(
            `Multiple users found (${users.length}). Adding app to all users...\n`,
          ),
        );
      }

      for (const user of users) {
        await insertUserAppRecord(
          accountId,
          databaseId,
          user,
          appId,
          appUrl,
          displayName,
          displayDescription,
          verbose,
        );
      }

      if (verbose) {
        console.log(`  UserApp records processed for ${users.length} users\n`);
      }
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
 * Insert a single UserApp record for a user
 */
async function insertUserAppRecord(
  accountId: string,
  databaseId: string,
  user: User,
  appId: string,
  appUrl: string,
  displayName: string,
  displayDescription: string,
  verbose: boolean,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Check if record already exists
  const existingRecords = await queryD1Database<{ id: string }>(
    accountId,
    databaseId,
    `SELECT id FROM user_apps WHERE user_id = '${user.id}' AND app_id = '${appId}'`,
  );

  if (existingRecords.length > 0) {
    // Skip - record already exists
    if (verbose) {
      console.log(
        chalk.dim(
          `  UserApp record already exists for user ${user.name} (${user.email})`,
        ),
      );
    }
  } else {
    // Insert new record
    const recordId = randomUUID();
    const insertSql = `
      INSERT INTO user_apps (id, user_id, app_id, name, description, app_url, created_at, updated_at)
      VALUES ('${recordId}', '${user.id}', '${appId}', '${displayName}', '${displayDescription}', '${appUrl}', ${now}, ${now})
    `;
    await queryD1Database(accountId, databaseId, insertSql);
    console.log(
      `  UserApp record created for user ${user.name} (${user.email})`,
    );
  }
}
