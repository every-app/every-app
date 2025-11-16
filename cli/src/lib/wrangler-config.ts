import fs from "node:fs/promises";
import path from "node:path";
import * as jsonc from "jsonc-parser";

export interface WranglerConfig {
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
  [key: string]: any;
}

interface UpdateWranglerConfigOptions {
  /**
   * New app/worker name (optional)
   */
  name?: string;
  /**
   * D1 database ID to set for all D1 databases
   */
  d1DatabaseId?: string;
  /**
   * D1 database name to set for all D1 databases (optional)
   */
  d1DatabaseName?: string;
  /**
   * KV namespace ID to set for all KV namespaces
   */
  kvNamespaceId?: string;
}

/**
 * Build JSONC edits for updating wrangler config
 * @param configContent - Original config file content
 * @param config - Parsed config object
 * @param options - Update options
 * @returns Array of JSONC edits
 */
function buildConfigEdits(
  configContent: string,
  config: WranglerConfig,
  options: UpdateWranglerConfigOptions,
): jsonc.Edit[] {
  const edits: jsonc.Edit[] = [];

  // Update name if provided
  if (options.name) {
    edits.push(...jsonc.modify(configContent, ["name"], options.name, {}));
  }

  // Update D1 database configuration
  if (config.d1_databases && options.d1DatabaseId) {
    config.d1_databases.forEach((_, index) => {
      // Update database_id
      edits.push(
        ...jsonc.modify(
          configContent,
          ["d1_databases", index, "database_id"],
          options.d1DatabaseId,
          {},
        ),
      );

      // Update database_name if provided
      if (options.d1DatabaseName) {
        edits.push(
          ...jsonc.modify(
            configContent,
            ["d1_databases", index, "database_name"],
            options.d1DatabaseName,
            {},
          ),
        );
      }
    });
  }

  // Update KV namespace IDs
  if (config.kv_namespaces && options.kvNamespaceId) {
    config.kv_namespaces.forEach((_, index) => {
      edits.push(
        ...jsonc.modify(
          configContent,
          ["kv_namespaces", index, "id"],
          options.kvNamespaceId,
          {},
        ),
      );
    });
  }

  return edits;
}

/**
 * Update wrangler.jsonc configuration file with new resource IDs
 * @param configPath - Path to wrangler.jsonc file
 * @param options - Configuration options to update
 */
export async function updateWranglerConfig(
  configPath: string,
  options: UpdateWranglerConfigOptions,
): Promise<void> {
  const configContent = await fs.readFile(configPath, "utf-8");
  const config: WranglerConfig = jsonc.parse(configContent);

  const edits = buildConfigEdits(configContent, config, options);

  const updatedContent = jsonc.applyEdits(configContent, edits);
  await fs.writeFile(configPath, updatedContent);
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
