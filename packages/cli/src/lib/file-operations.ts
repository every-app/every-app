import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";
import { getWorkerUrl } from "./cloudflare";

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

interface CreateEnvFilesOptions {
  targetDir: string;
  /** The unprefixed app ID (e.g., "todo-app") */
  appId: string;
  gatewayUrl?: string;
  gatewayAppApiToken?: string;
}

/**
 * Create environment files for the project
 */
export async function createEnvFiles({
  targetDir,
  appId,
  gatewayUrl: providedGatewayUrl,
  gatewayAppApiToken,
}: CreateEnvFilesOptions): Promise<void> {
  const gatewayUrl =
    providedGatewayUrl ?? (await getWorkerUrl("every-app-gateway"));

  const tokenLine = gatewayAppApiToken
    ? `GATEWAY_APP_API_TOKEN=${gatewayAppApiToken}\n`
    : "";

  const envLocalContent = `# Vite client-side secrets\nVITE_APP_ID=${appId}\nVITE_GATEWAY_URL=${gatewayUrl}\n# Set Cloudflare secrets locally\nGATEWAY_URL=${gatewayUrl}\n${tokenLine}`;

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

interface CleanupTempDirectoryOptions {
  tmpDir: string;
  verbose?: boolean;
}

/**
 * Cleanup a temporary directory
 */
export async function cleanupTempDirectory({
  tmpDir,
  verbose = false,
}: CleanupTempDirectoryOptions): Promise<void> {
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
    if (verbose) {
      console.log(chalk.dim(`  Removed: ${tmpDir}`));
    }
  } catch (error) {
    console.warn(
      chalk.yellow("⚠️  Warning: Failed to clean up temporary directory:"),
      tmpDir,
    );
  }
}
