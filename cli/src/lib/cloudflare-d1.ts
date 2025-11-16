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
): Promise<string> {
  console.log(chalk.bold(`Checking D1 database: ${databaseName}\n`));

  try {
    const databases = await listD1Databases();
    const existingDatabase = databases.find(
      (db: any) => db.name === databaseName,
    );

    if (existingDatabase) {
      console.log(
        chalk.green(
          `Linking to existing D1 database: ${databaseName} (${existingDatabase.uuid})\n`,
        ),
      );
      return existingDatabase.uuid;
    }

    console.log(chalk.bold(`Creating new D1 database: ${databaseName}\n`));
    const databaseId = await createD1Database(databaseName);
    console.log(
      chalk.green(`Created D1 database: ${databaseName} (${databaseId})\n`),
    );

    return databaseId;
  } catch (error) {
    console.error(
      chalk.red(`\nFailed to get or create D1 database: ${databaseName}`),
      error instanceof Error ? chalk.dim(`\n   ${error.message}`) : "",
    );
    throw error;
  }
}
