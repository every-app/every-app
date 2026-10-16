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
