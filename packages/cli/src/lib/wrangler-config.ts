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
  routes?: Array<Record<string, unknown>>;
  workers_dev?: boolean;
  services?: Array<{
    binding: string;
    service: string;
  }>;
  [key: string]: unknown;
}

interface UpdateWranglerConfigOptions {
  /**
   * Path to a Wrangler config file. If a directory is provided, wrangler.jsonc
   * in that directory is updated for gateway release compatibility.
   */
  configPath: string;
  name?: string;
  d1DatabaseId?: string;
  d1DatabaseName?: string;
  kvNamespaceIds?: Record<string, string>;
  r2BucketName?: string;
  vars?: Record<string, string>;
  routes?: Array<Record<string, unknown>>;
  workersDev?: boolean;
  services?: Array<{
    binding: string;
    service: string;
  }>;
  verbose?: boolean;
}

/**
 * Update a Wrangler config. This remains for gateway release deploys, where the
 * CLI patches the prebuilt gateway config with account-specific resources.
 */
export async function updateWranglerConfig(
  options: UpdateWranglerConfigOptions,
): Promise<void> {
  if (options.verbose) {
    console.log(
      "Updating Wrangler config with resource IDs and configuration...",
    );
  }

  let configFilePath = options.configPath;
  const stats = await fs.stat(configFilePath);
  if (stats.isDirectory()) {
    configFilePath = path.join(configFilePath, "wrangler.jsonc");
  }

  const configContent = await fs.readFile(configFilePath, "utf-8");
  const config: WranglerConfig = jsonc.parse(configContent);
  let edits: jsonc.Edit[] = [];

  if (config.d1_databases) {
    if (config.d1_databases.length === 0) {
      throw new Error(
        "No D1 databases found in Wrangler config. The gateway must have exactly one D1 database.",
      );
    }
    if (config.d1_databases.length > 1) {
      throw new Error(
        `Found ${config.d1_databases.length} D1 databases in Wrangler config. The gateway must have exactly one D1 database.`,
      );
    }
  }

  if (options.kvNamespaceIds) {
    const bindingCounts = new Map<string, number>();
    for (const namespace of config.kv_namespaces ?? []) {
      bindingCounts.set(
        namespace.binding,
        (bindingCounts.get(namespace.binding) ?? 0) + 1,
      );
    }

    for (const [binding, count] of bindingCounts) {
      if (count > 1) {
        throw new Error(
          `Found ${count} KV namespaces bound to "${binding}" in Wrangler config. Each KV binding must be declared exactly once.`,
        );
      }
      // Object.hasOwn, not a truthy lookup: a binding named after an
      // Object.prototype member (`constructor`, `toString`) would otherwise
      // resolve through the prototype chain, pass validation, and ship with
      // whatever id the config already had — the silent-wrong-id failure this
      // check exists to prevent.
      if (!Object.hasOwn(options.kvNamespaceIds, binding)) {
        throw new Error(
          `Wrangler config declares KV binding "${binding}", but the CLI did not provision it. Update gateway resource provisioning to include this binding before deploying.`,
        );
      }
    }

    for (const binding of Object.keys(options.kvNamespaceIds)) {
      if (!bindingCounts.has(binding)) {
        throw new Error(
          `The CLI provisioned KV binding "${binding}", but Wrangler config does not declare it. Update the gateway config and resource provisioning so the bindings match.`,
        );
      }
    }
  }

  if (config.r2_buckets && config.r2_buckets.length > 1) {
    throw new Error(
      `Found ${config.r2_buckets.length} R2 buckets in Wrangler config. The gateway must have at most one R2 bucket.`,
    );
  }

  if (options.name) {
    edits.push(...jsonc.modify(configContent, ["name"], options.name, {}));
  }

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

  if (options.kvNamespaceIds) {
    for (const [binding, namespaceId] of Object.entries(
      options.kvNamespaceIds,
    )) {
      const namespaceIndex =
        config.kv_namespaces?.findIndex(
          (namespace) => namespace.binding === binding,
        ) ?? -1;
      if (namespaceIndex >= 0) {
        edits.push(
          ...jsonc.modify(
            configContent,
            ["kv_namespaces", namespaceIndex, "id"],
            namespaceId,
            {},
          ),
        );
      }
    }
  }

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

  if (options.vars) {
    for (const [key, value] of Object.entries(options.vars)) {
      edits.push(...jsonc.modify(configContent, ["vars", key], value, {}));
    }
  }

  if (options.routes) {
    edits.push(...jsonc.modify(configContent, ["routes"], options.routes, {}));
  }

  if (typeof options.workersDev === "boolean") {
    edits.push(
      ...jsonc.modify(configContent, ["workers_dev"], options.workersDev, {}),
    );
  }

  if (options.services) {
    edits.push(
      ...jsonc.modify(configContent, ["services"], options.services, {}),
    );
  }

  const updatedContent = jsonc.applyEdits(configContent, edits);
  const placeholderIndex = updatedContent.indexOf("CLI_PATCHES_");
  if (placeholderIndex !== -1) {
    const leftoverPlaceholder =
      updatedContent
        .slice(placeholderIndex)
        .match(/^CLI_PATCHES_[A-Za-z0-9_]*/)?.[0] ?? "CLI_PATCHES_";
    throw new Error(
      `Wrangler config still contains unresolved placeholder "${leftoverPlaceholder}" after CLI patching.`,
    );
  }
  await fs.writeFile(configFilePath, updatedContent);

  if (options.verbose) {
    console.log(chalk.dim("  Wrangler config updated successfully\n"));
  }
}

export async function getWorkerName(configPath: string): Promise<string> {
  const configContent = await fs.readFile(configPath, "utf-8");
  const config: WranglerConfig = jsonc.parse(configContent);

  if (!config["name"] || typeof config["name"] !== "string") {
    throw new Error("Worker name not found in Wrangler config");
  }

  return config["name"];
}
