import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { getWorkerUrl } from "./cloudflare-auth";

interface CopyOptions {
  exclude?: string[];
}

/**
 * Recursively copy a directory
 * @param src - Source directory
 * @param dest - Destination directory
 * @param options - Copy options including exclusion patterns
 */
export async function copyDirectory(
  src: string,
  dest: string,
  options: CopyOptions = {},
): Promise<void> {
  const exclude = options.exclude || [];

  await fs.mkdir(dest, { recursive: true });

  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Check if this entry should be excluded
    if (exclude.some((pattern) => entry.name === pattern)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, options);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Check if a directory exists
 * @param dirPath - Path to check
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Update a JSON file with new values
 * @param filePath - Path to JSON file
 * @param updates - Object with updates to apply (deep merge)
 */
async function updateJsonFile(
  filePath: string,
  updates: Record<string, any>,
): Promise<void> {
  const content = await fs.readFile(filePath, "utf-8");
  const data = JSON.parse(content);

  // Deep merge updates into data
  Object.assign(data, updates);

  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Create environment files for the project
 * @param targetDir - Directory to create env files in
 * @param appId - App ID to use in environment variables
 */
export async function createEnvFiles(
  targetDir: string,
  appId: string,
): Promise<void> {
  // Get the every-app-gateway worker URL dynamically
  const gatewayUrl = await getWorkerUrl("every-app-gateway");

  const envLocalContent = `VITE_APP_ID=${appId}\nVITE_GATEWAY_URL=${gatewayUrl}\n`;

  await Promise.all([
    fs.writeFile(path.join(targetDir, ".env.local"), envLocalContent),
  ]);
}

/**
 * Create a temporary directory with a given prefix
 * @param prefix - Prefix for the temp directory name
 * @returns Path to the created temporary directory
 */
export async function createTempDirectory(prefix: string): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return tmpDir;
}

/**
 * Cleanup a temporary directory
 * @param tmpDir - Path to the temporary directory to remove
 * @param verbose - If true, log the cleanup action
 */
export async function cleanupTempDirectory(
  tmpDir: string,
  verbose = false,
): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (verbose) {
      console.log(chalk.dim(`   Removed: ${tmpDir}`));
    }
  } catch (error) {
    console.warn(
      chalk.yellow("⚠️  Warning: Failed to clean up temporary directory:"),
      tmpDir,
    );
  }
}
