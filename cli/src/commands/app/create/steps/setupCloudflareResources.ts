import chalk from "chalk";
import { getOrCreateD1Database } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";

/**
 * Set up Cloudflare D1 database and KV namespace for the new app
 */
export async function setupCloudflareResources(
  appId: string,
  verbose: boolean,
): Promise<{ d1DatabaseId: string; kvNamespaceId: string }> {
  if (!verbose) {
    console.log("\nCreating Cloudflare resources...\n");
  } else {
    console.log("Creating Cloudflare resources...\n");
  }

  const d1DatabaseId = await getOrCreateD1Database(appId, verbose);
  const kvNamespaceId = await getOrCreateKVNamespace(appId, verbose);

  if (verbose) {
    console.log("Cloudflare resources ready:\n");
    console.log(chalk.dim(`   D1 Database: ${appId} (${d1DatabaseId})`));
    console.log(chalk.dim(`   KV Namespace: ${appId} (${kvNamespaceId})\n`));
  }

  return { d1DatabaseId, kvNamespaceId };
}
