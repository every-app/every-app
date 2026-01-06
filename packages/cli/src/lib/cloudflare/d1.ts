import {
  D1DatabaseListSchema,
  type D1Database,
  type D1DatabaseResult,
} from "./types";
import { makeCloudflareAPIRequest } from "./auth";

interface D1DatabaseAPIResponse {
  uuid: string;
  name: string;
  created_at?: string;
  version?: string;
}

/**
 * List all D1 databases in the account using the Cloudflare REST API
 * GET /accounts/{account_id}/d1/database
 * Uses per_page=1000 to minimize pagination issues
 */
export async function listD1Databases(
  accountId: string,
): Promise<D1Database[]> {
  const result = await makeCloudflareAPIRequest<D1DatabaseAPIResponse[]>(
    `/accounts/${accountId}/d1/database?per_page=1000`,
  );
  return D1DatabaseListSchema.parse(result);
}

/**
 * Create a new D1 database using the Cloudflare REST API
 * POST /accounts/{account_id}/d1/database
 * @returns The database UUID
 */
async function createD1Database(
  databaseName: string,
  accountId: string,
): Promise<string> {
  const result = await makeCloudflareAPIRequest<D1DatabaseAPIResponse>(
    `/accounts/${accountId}/d1/database`,
    {
      method: "POST",
      body: JSON.stringify({ name: databaseName }),
    },
  );

  if (!result || !result.uuid) {
    throw new Error("Failed to create D1 database: no UUID returned");
  }

  return result.uuid;
}

/**
 * Get an existing D1 database or create a new one
 * Pure function - no logging, returns structured result
 */
export async function getOrCreateD1Database(
  databaseName: string,
  accountId: string,
): Promise<D1DatabaseResult> {
  const databases = await listD1Databases(accountId);
  const existingDatabase = databases.find((db) => db.name === databaseName);

  if (existingDatabase) {
    return {
      id: existingDatabase.uuid,
      name: databaseName,
      wasCreated: false,
    };
  }

  const databaseId = await createD1Database(databaseName, accountId);
  return {
    id: databaseId,
    name: databaseName,
    wasCreated: true,
  };
}
