import { getDefaultAccountId, listD1Databases } from "@/lib/cloudflare";

const GATEWAY_DB_NAME = "every-app-gateway";

/**
 * Connection details for the gateway database
 */
export interface GatewayDbConnection {
  accountId: string;
  databaseId: string;
}

/**
 * Get the gateway database connection details
 * @returns Connection details or null if the gateway database doesn't exist
 */
export async function getGatewayDatabase(): Promise<GatewayDbConnection | null> {
  const accountId = await getDefaultAccountId();
  const databases = await listD1Databases();

  const gatewayDb = databases.find((db) => db.name === GATEWAY_DB_NAME);

  if (!gatewayDb) {
    return null;
  }

  return {
    accountId,
    databaseId: gatewayDb.uuid,
  };
}
