import fs from "node:fs/promises";
import path from "node:path";

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
  gatewayUrl: string;
}

/**
 * Create environment files for the project
 */
export async function createEnvFiles({
  targetDir,
  appId,
  gatewayUrl,
}: CreateEnvFilesOptions): Promise<void> {

  const envLocalContent = `# Vite client-side secrets\nVITE_APP_ID=${appId}\nVITE_GATEWAY_URL=${gatewayUrl}\n# Set Cloudflare secrets locally\nGATEWAY_URL=${gatewayUrl}\n`;

  await Promise.all([
    fs.writeFile(path.join(targetDir, ".env.local"), envLocalContent),
  ]);
}
