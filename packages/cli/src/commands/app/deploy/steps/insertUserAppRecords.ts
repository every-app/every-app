import chalk from "chalk";
import enquirer from "enquirer";
import {
  getGatewayDatabase,
  getAllUsers,
  getAppCatalogByAppId,
  upsertAppCatalog,
  upsertUserAppAccess,
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
    const existingApp = await getAppCatalogByAppId(db, appId);
    const isFirstDeploy = existingApp === null;

    const displayName = appName || appId;
    const displayDescription = appDescription || appId;

    if (!isFirstDeploy && verbose) {
      console.log(
        chalk.dim(
          "App already configured in gateway. Skipping access prompts.",
        ),
      );
    }

    const resolvedDefaultAccess = isFirstDeploy
      ? await promptForDefaultAccess("Add future users by default to this app?")
      : Boolean(existingApp?.is_default);

    const resolvedAccessMode = isFirstDeploy
      ? await promptForAccessMode()
      : "none";

    let resolvedUserIds: string[] = [];
    if (users.length === 0 && resolvedAccessMode === "select") {
      throw new Error(
        "No users found in the database to select from. Please create a user first.",
      );
    }
    if (resolvedAccessMode === "all") {
      resolvedUserIds = users.map((user) => user.id);
    } else if (resolvedAccessMode === "select") {
      resolvedUserIds = await promptForUserSelection(users);
    }

    const appRecordId = await upsertAppCatalog(db, {
      appId,
      appUrl,
      name: displayName,
      description: displayDescription,
      devUrl,
      isDefault: resolvedDefaultAccess,
    });

    const usersToProcess = users.filter((user) =>
      resolvedUserIds.includes(user.id),
    );

    if (verbose && usersToProcess.length > 1) {
      console.log(
        chalk.yellow(`Adding app to ${usersToProcess.length} user(s)...\n`),
      );
    }

    for (const user of usersToProcess) {
      await processUserAppRecord(db, user, {
        appRecordId,
        verbose,
      });
    }

    if (verbose) {
      const accessLabel =
        resolvedAccessMode === "all"
          ? "all users"
          : resolvedAccessMode === "select"
            ? `${usersToProcess.length} selected users`
            : "no users";
      console.log(
        chalk.dim(
          `  Default access: ${resolvedDefaultAccess ? "enabled" : "disabled"}`,
        ),
      );
      console.log(chalk.dim(`  Access granted to ${accessLabel}\n`));
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
    appRecordId: string;
    verbose: boolean;
  },
): Promise<void> {
  const { verbose, appRecordId } = options;

  const result = await upsertUserAppAccess(db, user.id, appRecordId);

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

async function promptForDefaultAccess(message: string): Promise<boolean> {
  const { confirm } = await enquirer.prompt<{ confirm: boolean }>({
    type: "confirm",
    name: "confirm",
    message,
    initial: true,
  });

  return confirm;
}

async function promptForAccessMode(): Promise<"all" | "select" | "none"> {
  const { mode } = await enquirer.prompt<{ mode: "all" | "select" | "none" }>({
    type: "select",
    name: "mode",
    message: "Add existing users now?",
    choices: [
      { name: "all", message: "All users" },
      { name: "select", message: "Select users" },
      { name: "none", message: "None" },
    ],
    initial: 0,
  });

  return mode;
}

async function promptForUserSelection(users: User[]): Promise<string[]> {
  const { selected } = await enquirer.prompt<{ selected: string[] }>({
    type: "multiselect",
    name: "selected",
    message: "Select users to grant access",
    choices: users.map((user) => ({
      name: user.id,
      message: formatUserLabel(user),
    })),
  });

  return selected;
}

function formatUserLabel(user: User): string {
  if (user.name && user.name.trim()) {
    return `${user.name} <${user.email}>`;
  }

  return user.email;
}
