/**
 * The gateway's own Cloudflare resources, found by name (KV: title) and
 * created when missing: its D1 database and the OAuth provider's KV
 * namespace.
 */
import type { CfRunner } from "@/lib/cf/runner";
import { findD1, findKv, getOrCreateD1, getOrCreateKv } from "@/lib/cf/resources";

const GATEWAY_D1_NAME = "every-app-gateway";
const GATEWAY_OAUTH_KV_TITLE = "every-app-gateway-OAUTH_KV";

export interface GatewayResources {
  d1Id: string;
  oauthKvId: string;
  /** What this run created, for the log. */
  created: string[];
}

export async function ensureGatewayResources(
  cf: CfRunner,
): Promise<GatewayResources> {
  const d1 = await getOrCreateD1(cf, GATEWAY_D1_NAME);
  const oauthKv = await getOrCreateKv(cf, GATEWAY_OAUTH_KV_TITLE);
  return {
    d1Id: d1.id,
    oauthKvId: oauthKv.id,
    created: [
      ...(d1.created ? [`D1 ${GATEWAY_D1_NAME}`] : []),
      ...(oauthKv.created ? [`KV ${GATEWAY_OAUTH_KV_TITLE}`] : []),
    ],
  };
}

/**
 * The gateway's resources when both are there, never creating either
 * (`update`, which never installs a Gateway); null when one is missing.
 */
export async function existingGatewayResources(cf: CfRunner): Promise<GatewayResources | null> {
  const [d1Id, oauthKvId] = await Promise.all([
    findD1(cf, GATEWAY_D1_NAME),
    findKv(cf, GATEWAY_OAUTH_KV_TITLE),
  ]);
  return d1Id && oauthKvId ? { d1Id, oauthKvId, created: [] } : null;
}

/** The gateway's D1 database id, or null when no gateway was deployed here. */
export function findGatewayDatabase(cf: CfRunner): Promise<string | null> {
  return findD1(cf, GATEWAY_D1_NAME);
}
