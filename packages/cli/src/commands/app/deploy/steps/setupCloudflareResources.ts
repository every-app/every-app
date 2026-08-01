import chalk from "chalk";
import {
  getOrCreateD1Database,
  getOrCreateKVNamespace,
  getOrCreateR2Bucket,
  getDefaultAccountId,
  formatCloudflareError,
} from "@/lib/cloudflare";
import { resourceNameFor } from "@/lib/generateWranglerConfig";
import { exitWithUpdateNotice } from "@/lib/version-check";

interface SetupCloudflareResourcesOptions {
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  /** D1 binding names declared in everyapp.config.ts */
  d1Bindings?: string[];
  /** KV binding names declared in everyapp.config.ts */
  kvBindings?: string[];
  /** Whether the app needs an R2 bucket */
  needsR2Bucket?: boolean;
  verbose?: boolean;
}

interface SetupCloudflareResourcesResult {
  d1DatabaseId?: string;
  kvNamespaceId?: string;
  d1DatabaseIds: Record<string, string>;
  kvNamespaceIds: Record<string, string>;
  /** The R2 bucket name if configured */
  r2BucketName?: string;
  /** The prefixed resource name used for D1 and KV */
  resourceName: string;
}

/**
 * Set up Cloudflare resources (D1 database, KV namespace, and optionally R2 bucket).
 * Returns the D1 database ID, KV namespace ID, optional R2 bucket name, and the prefixed resource name.
 *
 * Note: Uses prefixed appId for all resource names
 * (e.g., "my-app" becomes "every-my-app" for resources)
 */
export async function setupCloudflareResources({
  appId,
  d1Bindings = ["DB"],
  kvBindings = ["KV"],
  needsR2Bucket = false,
  verbose = false,
}: SetupCloudflareResourcesOptions): Promise<SetupCloudflareResourcesResult> {
  const resourceTypes = [
    d1Bindings.length > 0 ? "D1 Database" : null,
    kvBindings.length > 0 ? "KV Store" : null,
    needsR2Bucket ? "R2 Bucket" : null,
  ].filter(Boolean);
  if (resourceTypes.length > 0) {
    console.log(`\nSetting up your Cloudflare ${resourceTypes.join(", ")}...\n`);
  }

  const accountId = await getDefaultAccountId();
  const resourceName = resourceNameFor(appId);

  // Set up R2 first so we don't create D1/KV if R2 is not enabled
  let r2BucketName: string | undefined;
  if (needsR2Bucket) {
    r2BucketName = await setupR2Bucket(resourceName, accountId, verbose);
  }

  const d1DatabaseIds: Record<string, string> = {};
  for (const binding of d1Bindings) {
    const databaseName = resourceNameFor(appId, binding);
    d1DatabaseIds[binding] = await setupD1Database(
      databaseName,
      accountId,
      verbose,
    );
  }

  const kvNamespaceIds: Record<string, string> = {};
  for (const binding of kvBindings) {
    const namespaceName = resourceNameFor(appId, binding);
    kvNamespaceIds[binding] = await setupKVNamespace(
      namespaceName,
      accountId,
      verbose,
    );
  }

  return {
    d1DatabaseId: d1DatabaseIds["DB"],
    kvNamespaceId: kvNamespaceIds["KV"],
    d1DatabaseIds,
    kvNamespaceIds,
    r2BucketName,
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
      console.log(chalk.green("  D1 successfully created."));
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

/**
 * Set up R2 bucket and log the result.
 * Returns the bucket name.
 */
async function setupR2Bucket(
  resourceName: string,
  accountId: string,
  verbose: boolean,
): Promise<string> {
  if (verbose) {
    console.log(chalk.bold("Processing R2 bucket...\n"));
    console.log(`  Checking R2 bucket: ${resourceName}`);
  }

  let result;
  try {
    result = await getOrCreateR2Bucket(resourceName, accountId);
  } catch (error) {
    // Check for known Cloudflare errors (e.g., R2 not enabled)
    const cloudflareError = await formatCloudflareError(error, { accountId });
    if (cloudflareError) {
      console.log(cloudflareError.formatted);
      await exitWithUpdateNotice(1);
    }
    throw error;
  }

  if (verbose) {
    if (result.wasCreated) {
      console.log(chalk.green(`  Created R2 bucket: ${resourceName}\n`));
    } else {
      console.log(
        chalk.dim(`  Linking to existing R2 bucket: ${resourceName}\n`),
      );
    }
  } else {
    if (result.wasCreated) {
      console.log(chalk.green("  R2 successfully created."));
    } else {
      console.log("  R2 already set up.");
    }
  }

  return result.name;
}
