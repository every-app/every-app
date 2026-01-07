import fs from "node:fs/promises";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import chalk from "chalk";

interface WranglerConfig {
  name?: string;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id: string;
  }>;
  kv_namespaces?: Array<{
    binding: string;
    id: string;
  }>;
  r2_buckets?: Array<{
    binding: string;
    bucket_name: string;
  }>;
  [key: string]: any;
}

interface UpdateWranglerConfigOptions {
  /**
   * Path to wrangler.jsonc file (or directory containing it)
   * If a directory is provided, will look for wrangler.jsonc in that directory
   */
  configPath: string;
  /**
   * New app/worker name (updates the "name" field)
   */
  name?: string;
  /**
   * D1 database ID to set (we only support one D1 database per app)
   */
  d1DatabaseId?: string;
  /**
   * D1 database name to set (we only support one D1 database per app)
   */
  d1DatabaseName?: string;
  /**
   * KV namespace ID to set (we only support one KV namespace per app)
   */
  kvNamespaceId?: string;
  /**
   * R2 bucket name to set (we only support one R2 bucket per app)
   */
  r2BucketName?: string;
  /**
   * Vars to set in wrangler config (e.g., GATEWAY_URL)
   */
  vars?: Record<string, string>;
  /**
   * Whether to show verbose output
   */
  verbose?: boolean;
}

/**
 * Unified function to update wrangler.jsonc configuration
 * Supports updating D1 database, KV namespace, and vars in a single operation
 *
 * Enforces the invariant that each app has exactly one D1 database and one KV namespace
 */
export async function updateWranglerConfig(
  options: UpdateWranglerConfigOptions,
): Promise<void> {
  if (options.verbose) {
    console.log(
      "Updating wrangler.jsonc with resource IDs and configuration...",
    );
  }

  // Determine the actual config file path
  let configFilePath = options.configPath;
  const stats = await fs.stat(configFilePath);
  if (stats.isDirectory()) {
    configFilePath = path.join(configFilePath, "wrangler.jsonc");
  }

  const configContent = await fs.readFile(configFilePath, "utf-8");
  const config: WranglerConfig = jsonc.parse(configContent);
  let edits: jsonc.Edit[] = [];

  // Validate invariants: exactly one D1 database and one KV namespace
  if (config.d1_databases) {
    if (config.d1_databases.length === 0) {
      throw new Error(
        "No D1 databases found in wrangler.jsonc. Every app must have exactly one D1 database.",
      );
    }
    if (config.d1_databases.length > 1) {
      throw new Error(
        `Found ${config.d1_databases.length} D1 databases in wrangler.jsonc. Every app must have exactly one D1 database.`,
      );
    }
  }

  if (config.kv_namespaces) {
    if (config.kv_namespaces.length === 0) {
      throw new Error(
        "No KV namespaces found in wrangler.jsonc. Every app must have exactly one KV namespace.",
      );
    }
    if (config.kv_namespaces.length > 1) {
      throw new Error(
        `Found ${config.kv_namespaces.length} KV namespaces in wrangler.jsonc. Every app must have exactly one KV namespace.`,
      );
    }
  }

  // R2 buckets are optional, but if present must have at most one
  if (config.r2_buckets && config.r2_buckets.length > 1) {
    throw new Error(
      `Found ${config.r2_buckets.length} R2 buckets in wrangler.jsonc. Every app must have at most one R2 bucket.`,
    );
  }

  // Update name if provided
  if (options.name) {
    edits.push(...jsonc.modify(configContent, ["name"], options.name, {}));
  }

  // Update D1 database ID (index 0 since we enforce exactly one)
  if (options.d1DatabaseId) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["d1_databases", 0, "database_id"],
        options.d1DatabaseId,
        {},
      ),
    );
  }

  // Update D1 database name (index 0 since we enforce exactly one)
  if (options.d1DatabaseName) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["d1_databases", 0, "database_name"],
        options.d1DatabaseName,
        {},
      ),
    );
  }

  // Update KV namespace ID (index 0 since we enforce exactly one)
  if (options.kvNamespaceId) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["kv_namespaces", 0, "id"],
        options.kvNamespaceId,
        {},
      ),
    );
  }

  // Update R2 bucket name (index 0 since we enforce at most one)
  if (options.r2BucketName && config.r2_buckets?.length) {
    edits.push(
      ...jsonc.modify(
        configContent,
        ["r2_buckets", 0, "bucket_name"],
        options.r2BucketName,
        {},
      ),
    );
  }

  // Update vars
  if (options.vars) {
    for (const [key, value] of Object.entries(options.vars)) {
      edits.push(...jsonc.modify(configContent, ["vars", key], value, {}));
    }
  }

  const updatedContent = jsonc.applyEdits(configContent, edits);
  await fs.writeFile(configFilePath, updatedContent);

  if (options.verbose) {
    console.log(chalk.dim("  wrangler.jsonc updated successfully\n"));
  }
}

/**
 * Get worker name from wrangler.jsonc
 * @param configPath - Path to wrangler.jsonc file
 * @returns The worker name
 */
export async function getWorkerName(configPath: string): Promise<string> {
  const configContent = await fs.readFile(configPath, "utf-8");
  const config: WranglerConfig = jsonc.parse(configContent);

  if (!config["name"] || typeof config["name"] !== "string") {
    throw new Error("Worker name not found in wrangler.jsonc");
  }

  return config["name"];
}

/**
 * Read and parse wrangler.jsonc from a directory
 * @param cwd - Directory containing wrangler.jsonc
 * @returns Parsed wrangler configuration
 */
export async function readWranglerConfig(cwd: string): Promise<WranglerConfig> {
  const wranglerPath = path.join(cwd, "wrangler.jsonc");

  try {
    const configContent = await fs.readFile(wranglerPath, "utf-8");
    const config: WranglerConfig = jsonc.parse(configContent);
    return config;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(
        "wrangler.jsonc not found in current directory. Make sure you're running this command from your app's root directory.",
      );
    }
    throw error;
  }
}
