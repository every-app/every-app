import { execa } from "execa";
import {
  D1DatabaseListSchema,
  type D1Database,
  type D1DatabaseResult,
} from "./types";

/**
 * List all D1 databases in the account
 */
export async function listD1Databases(): Promise<D1Database[]> {
  const { stdout } = await execa("npx", ["wrangler", "d1", "list", "--json"]);
  const parsed = JSON.parse(stdout);
  return D1DatabaseListSchema.parse(parsed);
}

/**
 * Create a new D1 database
 * @returns The database UUID
 */
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

/**
 * Get an existing D1 database or create a new one
 * Pure function - no logging, returns structured result
 */
export async function getOrCreateD1Database(
  databaseName: string,
): Promise<D1DatabaseResult> {
  const databases = await listD1Databases();
  const existingDatabase = databases.find((db) => db.name === databaseName);

  if (existingDatabase) {
    return {
      id: existingDatabase.uuid,
      name: databaseName,
      wasCreated: false,
    };
  }

  const databaseId = await createD1Database(databaseName);
  return {
    id: databaseId,
    name: databaseName,
    wasCreated: true,
  };
}
