/**
 * The gateway's own Cloudflare resources, found by name (KV: title) and
 * created when missing: its D1 database, the OAuth provider's KV namespace,
 * and the deploy KV namespace that caches the live release.
 */
import type { CfRunner } from "@/lib/cf/runner";
import { findD1, getOrCreateD1, getOrCreateKv } from "@/lib/cf/resources";

const GATEWAY_D1_NAME = "every-app-gateway";
const GATEWAY_OAUTH_KV_TITLE = "every-app-gateway-OAUTH_KV";
const GATEWAY_DEPLOY_KV_TITLE = "every-app-gateway-deploy";

export interface GatewayResources {
  d1Id: string;
  oauthKvId: string;
  deployKvId: string;
  /** What this run created, for the log. */
  created: string[];
}

export async function ensureGatewayResources(
  cf: CfRunner,
): Promise<GatewayResources> {
  const d1 = await getOrCreateD1(cf, GATEWAY_D1_NAME);
  const oauthKv = await getOrCreateKv(cf, GATEWAY_OAUTH_KV_TITLE);
  const deployKv = await getOrCreateKv(cf, GATEWAY_DEPLOY_KV_TITLE);
  return {
    d1Id: d1.id,
    oauthKvId: oauthKv.id,
    deployKvId: deployKv.id,
    created: [
      ...(d1.created ? [`D1 ${GATEWAY_D1_NAME}`] : []),
      ...(oauthKv.created ? [`KV ${GATEWAY_OAUTH_KV_TITLE}`] : []),
      ...(deployKv.created ? [`KV ${GATEWAY_DEPLOY_KV_TITLE}`] : []),
    ],
  };
}

/** The gateway's D1 database id, or null when no gateway was deployed here. */
export function findGatewayDatabase(cf: CfRunner): Promise<string | null> {
  return findD1(cf, GATEWAY_D1_NAME);
}
