import chalk from "chalk";
import {
  getOrCreateD1Database,
  getOrCreateKVNamespace,
  getDefaultAccountId,
  applyResourcePrefix,
} from "@/lib/cloudflare";

interface SetupCloudflareResourcesOptions {
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  verbose?: boolean;
}

interface SetupCloudflareResourcesResult {
  d1DatabaseId: string;
  kvNamespaceId: string;
  /** The prefixed resource name used for D1 and KV */
  resourceName: string;
}

/**
 * Set up Cloudflare resources (D1 database and KV namespace).
 * Returns the D1 database ID, KV namespace ID, and the prefixed resource name.
 *
 * Note: Uses prefixed appId for both D1 database name and KV namespace name
 * (e.g., "my-app" becomes "every-my-app" for resources)
 */
export async function setupCloudflareResources({
  appId,
  verbose = false,
}: SetupCloudflareResourcesOptions): Promise<SetupCloudflareResourcesResult> {
  console.log("\nSetting up your Cloudflare D1 Database and KV Store...\n");

  const accountId = await getDefaultAccountId();
  const resourceName = applyResourcePrefix(appId);

  const d1DatabaseId = await setupD1Database(resourceName, accountId, verbose);
  const kvNamespaceId = await setupKVNamespace(
    resourceName,
    accountId,
    verbose,
  );

  return {
    d1DatabaseId,
    kvNamespaceId,
    resourceName,
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
    console.log(chalk.bold("Processing D1 database...\n"));
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
    console.log(chalk.bold("Processing KV namespace...\n"));
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
