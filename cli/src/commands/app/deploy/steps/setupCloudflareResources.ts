import chalk from "chalk";
import { getOrCreateD1Database } from "@/lib/cloudflare-d1";
import { getOrCreateKVNamespace } from "@/lib/cloudflare-kv";
import type { WranglerConfig } from "@/lib/wrangler-config";

interface D1DatabaseConfig {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir?: string;
}

/**
 * Set up Cloudflare resources based on wrangler.jsonc configuration
 * Returns the D1 database ID and KV namespace ID
 * 
 * Enforces the invariant that each app has exactly one D1 database and one KV namespace
 */
export async function setupCloudflareResources(
  config: WranglerConfig,
  workerName: string,
  verbose: boolean = false,
): Promise<{ d1DatabaseId: string; kvNamespaceId: string }> {
  console.log("\nSetting up Cloudflare your D1 Database and KV Store...\n");

  // Validate D1 database configuration
  if (!config.d1_databases || config.d1_databases.length === 0) {
    throw new Error(
      "No D1 databases found in wrangler.jsonc. Every app must have exactly one D1 database.",
    );
  }
  if (config.d1_databases.length > 1) {
    throw new Error(
      `Found ${config.d1_databases.length} D1 databases in wrangler.jsonc. Every app must have exactly one D1 database.`,
    );
  }

  // Validate KV namespace configuration
  if (!config.kv_namespaces || config.kv_namespaces.length === 0) {
    throw new Error(
      "No KV namespaces found in wrangler.jsonc. Every app must have exactly one KV namespace.",
    );
  }
  if (config.kv_namespaces.length > 1) {
    throw new Error(
      `Found ${config.kv_namespaces.length} KV namespaces in wrangler.jsonc. Every app must have exactly one KV namespace.`,
    );
  }

  // Get the single D1 database
  const db = config.d1_databases[0] as D1DatabaseConfig;
  const databaseName = db.database_name;

  if (!databaseName) {
    throw new Error("D1 database in wrangler.jsonc must have a database_name.");
  }

  if (verbose) {
    console.log(chalk.bold("Processing D1 database...\n"));
  }

  const d1DatabaseId = await getOrCreateD1Database(databaseName, verbose);

  // Get the single KV namespace
  if (verbose) {
    console.log(chalk.bold("Processing KV namespace...\n"));
  }

  // Use worker name for KV namespace
  const kvNamespaceId = await getOrCreateKVNamespace(workerName, verbose);

  return { d1DatabaseId, kvNamespaceId };
}
