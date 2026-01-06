import chalk from "chalk";
import {
  getOrCreateD1Database,
  getOrCreateKVNamespace,
  getDefaultAccountId,
} from "@/lib/cloudflare";
import type { CloudflareResources } from "@/commands/gateway/deploy/types";

// Constants - gateway uses full name (already has "every-app-" prefix)
const D1_DATABASE_NAME = "every-app-gateway";
const KV_NAMESPACE_NAME = "every-app-gateway";

interface SetupCloudflareResourcesOptions {
  verbose?: boolean;
}

/**
 * Set up Cloudflare resources (D1 database and KV namespace) for the gateway.
 */
export async function setupCloudflareResources({
  verbose = false,
}: SetupCloudflareResourcesOptions = {}): Promise<CloudflareResources> {
  console.log("\nSetting up your Cloudflare D1 Database and KV Store...\n");

  const accountId = await getDefaultAccountId();

  const d1DatabaseId = await setupD1Database(
    D1_DATABASE_NAME,
    accountId,
    verbose,
  );
  const kvNamespaceId = await setupKVNamespace(
    KV_NAMESPACE_NAME,
    accountId,
    verbose,
  );

  return {
    d1DatabaseId,
    kvNamespaceId,
    accountId,
  };
}

/**
 * Set up D1 database and log the result.
 * Returns the database ID.
 */
async function setupD1Database(
  resourceName: string,
  accountId: string,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.log(`  Checking D1 database: ${resourceName}`);
  }

  const result = await getOrCreateD1Database(resourceName, accountId);

  if (verbose) {
    if (result.wasCreated) {
      console.log(
        chalk.green(`  Created D1 database: ${resourceName} (${result.id})\n`),
      );
    } else {
      console.log(
        chalk.dim(
          `  Linking to existing D1 database: ${resourceName} (${result.id})\n`,
        ),
      );
    }
  } else {
    if (result.wasCreated) {
      console.log(chalk.green("  D1 successfully created.\n"));
    } else {
      console.log("  D1 already set up.");
    }
  }

  return result.id;
}

/**
 * Set up KV namespace and log the result.
 * Returns the namespace ID.
 */
async function setupKVNamespace(
  resourceName: string,
  accountId: string,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.log(`  Checking KV namespace: ${resourceName}`);
  }

  const result = await getOrCreateKVNamespace(resourceName, accountId);

  if (verbose) {
    if (result.wasCreated) {
      console.log(
        chalk.green(`  Created KV namespace: ${resourceName} (${result.id})\n`),
      );
    } else {
      console.log(
        chalk.dim(
          `  Linking to existing KV namespace: ${resourceName} (${result.id})\n`,
        ),
      );
    }
  } else {
    if (result.wasCreated) {
      console.log(chalk.green("  KV successfully created."));
    } else {
      console.log("  KV already set up.");
    }
  }

  return result.id;
}
