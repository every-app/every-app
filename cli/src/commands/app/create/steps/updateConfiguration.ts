import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { updateWranglerConfig } from "@/lib/wrangler-config";
import { createEnvFiles } from "@/lib/file-operations";

/**
 * Update package.json with app ID
 */
async function updatePackageJson(
  targetDir: string,
  appId: string,
): Promise<void> {
  const packageJsonPath = path.join(targetDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf-8"));

  packageJson.name = appId;

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Update configuration files with app ID and Cloudflare resource IDs
 */
export async function updateConfiguration(
  targetDir: string,
  appId: string,
  d1DatabaseId: string,
  kvNamespaceId: string,
  verbose: boolean,
): Promise<void> {
  if (verbose) {
    console.log("Updating configuration files...\n");
  }

  const wranglerPath = path.join(targetDir, "wrangler.jsonc");
  await updateWranglerConfig({
    configPath: wranglerPath,
    name: appId,
    d1DatabaseId: d1DatabaseId,
    d1DatabaseName: appId,
    kvNamespaceId: kvNamespaceId,
    verbose,
  });

  await updatePackageJson(targetDir, appId);
  await createEnvFiles(targetDir, appId);

  if (verbose) {
    console.log(chalk.dim("  Configuration updated"));
  }
}
