import { getOrCreateD1Database } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";
import { getDefaultAccountId } from "@/lib/cloudflare-auth";
import type { CloudflareResources } from "@/commands/gateway/deploy/types";

// Constants
const D1_DATABASE_NAME = "every-app-gateway";
const KV_NAMESPACE_NAME = "every-app-gateway";

/**
 * Set up Cloudflare resources (D1 database and KV namespace)
 */
export async function setupCloudflareResources(
  verbose: boolean = false,
): Promise<CloudflareResources> {
  console.log("\nSetting up Cloudflare your D1 Database and KV Store...\n");

  const accountId = await getDefaultAccountId();

  const d1DatabaseId = await getOrCreateD1Database(D1_DATABASE_NAME, verbose);
  const kvNamespaceId = await getOrCreateKVNamespace(
    KV_NAMESPACE_NAME,
    verbose,
  );

  return { d1DatabaseId, kvNamespaceId, accountId };
}
