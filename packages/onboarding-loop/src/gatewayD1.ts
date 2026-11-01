/**
 * The gateway's D1 as the claim and the link expiry see it (design 4.5,
 * 4.2 step 9): a D1Client over cf.ts's query endpoint that finds the
 * database named `every-app-gateway` the first time it is asked, and
 * answers an empty result while `setup` has not created it yet, so the
 * D1-side claimer can start polling before the gateway exists.
 */
import type { CfApi } from "./cf";
import type { D1Client } from "./types";

export const GATEWAY_D1_NAME = "every-app-gateway";

interface GatewayD1 extends D1Client {
  /** The database's id once it exists, else null; cached once found. */
  databaseId(): Promise<string | null>;
}

export function createGatewayD1(cf: CfApi): GatewayD1 {
  let cached: string | null = null;
  const databaseId = async (): Promise<string | null> => {
    if (cached) return cached;
    const rows = await cf.d1List(GATEWAY_D1_NAME);
    const row = rows.find((database) => database.name === GATEWAY_D1_NAME);
    cached = row?.uuid ?? null;
    return cached;
  };
  return {
    databaseId,
    async query(sql, params = []) {
      const id = await databaseId();
      if (!id) return [];
      const statements = await cf.d1Query(id, sql, params);
      return statements.flatMap((statement) => statement.results);
    },
  };
}
