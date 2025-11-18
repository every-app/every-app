import { execa } from "execa";
import chalk from "chalk";

export async function listD1Databases(): Promise<any[]> {
  const { stdout } = await execa("npx", ["wrangler", "d1", "list", "--json"]);
  return JSON.parse(stdout);
}

async function createD1Database(databaseName: string): Promise<string> {
  const { stdout } = await execa("npx", [
    "wrangler",
    "d1",
    "create",
    databaseName,
  ]);

  // Parse the output to extract the database_id
  // Output format includes: "database_id": "uuid-here"
  const match = stdout.match(/"database_id":\s*"([^"]+)"/);
  if (!match || !match[1]) {
    throw new Error("Failed to parse database ID from wrangler output");
  }

  return match[1];
}

export async function getOrCreateD1Database(
  databaseName: string,
  verbose: boolean = false,
): Promise<string> {
  if (verbose) {
    console.log(`  Checking D1 database: ${databaseName}`);
  }

  try {
    const databases = await listD1Databases();
    const existingDatabase = databases.find(
      (db: any) => db.name === databaseName,
    );

    if (existingDatabase) {
      if (verbose) {
        console.log(
          chalk.dim(
            `  Linking to existing D1 database: ${databaseName} (${existingDatabase.uuid})\n`,
          ),
        );
      } else {
        console.log("  D1 already set up.");
      }
      return existingDatabase.uuid;
    }

    if (verbose) {
      console.log(chalk.dim(`  Creating new D1 database: ${databaseName}`));
    }
    const databaseId = await createD1Database(databaseName);
    if (verbose) {
      console.log(
        chalk.green(`  Created D1 database: ${databaseName} (${databaseId})\n`),
      );
    } else {
      console.log(chalk.green("  D1 successfully created.\n"));
    }

    return databaseId;
  } catch (error) {
    console.error(
      chalk.red(`Failed to get or create D1 database: ${databaseName}`),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}
