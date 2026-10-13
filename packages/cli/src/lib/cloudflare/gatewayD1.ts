import { makeCloudflareAPIRequest } from "@/lib/cloudflare/auth";
import { listD1Databases } from "@/lib/cloudflare/d1";

const GATEWAY_D1_DATABASE_NAME = "every-app-gateway";

type D1Value = string | number | null;
type D1Row = Record<string, unknown>;

interface D1QueryResponse {
  results?: D1Row[];
  result?: D1Row[];
}

/** The gateway's D1 database id in this account, or null before a deploy. */
export async function findGatewayDatabaseId(
  accountId: string,
): Promise<string | null> {
  const databases = await listD1Databases(accountId);
  return (
    databases.find((database) => database.name === GATEWAY_D1_DATABASE_NAME)
      ?.uuid ?? null
  );
}

/**
 * Run one statement against the gateway's D1 over the Cloudflare REST API,
 * with bound parameters. The CLI uses this to act on the gateway with the
 * deployer's Cloudflare credentials, which are the trust root for the
 * gateway: it works before the gateway is reachable and without a session.
 */
export async function queryGatewayD1(
  accountId: string,
  databaseId: string,
  sql: string,
  params: D1Value[] = [],
): Promise<D1Row[]> {
  const response = await makeCloudflareAPIRequest<
    D1QueryResponse | D1QueryResponse[]
  >(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify(params.length > 0 ? { sql, params } : { sql }),
  });

  const first = Array.isArray(response) ? response[0] : response;
  return first?.results ?? first?.result ?? [];
}
