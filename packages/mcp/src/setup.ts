import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync } from "node:child_process";

// Default location for examples
const DEFAULT_EXAMPLES_DIR = path.join(os.homedir(), ".every-app-mcp", "examples");

// Repository info
const REPO_URL = "https://github.com/every-app/every-app.git";

/**
 * Get the examples directory
 */
export function getExamplesDirectory(): string {
  return DEFAULT_EXAMPLES_DIR;
}

/**
 * Check if git is available
 */
function hasGit(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone or update the examples repository
 * Uses a shallow clone for speed
 */
export async function ensureExamplesExist(): Promise<{
  success: boolean;
  dir: string;
  message: string;
}> {
  const examplesDir = getExamplesDirectory();

  // Check if examples already exist
  if (fs.existsSync(examplesDir)) {
    // Try to update if it's a git repo
    if (fs.existsSync(path.join(examplesDir, ".git"))) {
      try {
        execFileSync("git", ["fetch", "--depth=1", "origin", "main"], {
          cwd: examplesDir,
          stdio: "ignore",
          timeout: 30000,
        });
        execFileSync("git", ["reset", "--hard", "origin/main"], {
          cwd: examplesDir,
          stdio: "ignore",
          timeout: 30000,
        });
        return {
          success: true,
          dir: examplesDir,
          message: "Examples updated successfully",
        };
      } catch {
        return {
          success: false,
          dir: examplesDir,
          message: "Failed to update examples repository",
        };
      }
    }

    // Existing directory isn't a git repo; remove and re-clone
    try {
      fs.rmSync(examplesDir, { recursive: true, force: true });
    } catch {
      return {
        success: false,
        dir: examplesDir,
        message: "Existing examples directory is not a git repo",
      };
    }
  }

  // Need to clone the examples
  if (!hasGit()) {
    return {
      success: false,
      dir: examplesDir,
      message:
        "Git is not installed. Please install git and try again, or manually clone the examples.",
    };
  }

  // Create parent directory
  const parentDir = path.dirname(examplesDir);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  try {
    console.error("Cloning Every App examples (this may take a moment)...");

    execFileSync(
      "git",
      ["clone", "--depth=1", REPO_URL, examplesDir],
      { stdio: "ignore", timeout: 120000 }
    );

    return {
      success: true,
      dir: examplesDir,
      message: `Examples cloned to ${examplesDir}`,
    };
  } catch (error) {
    // Clean up failed clone
    if (fs.existsSync(examplesDir)) {
      try {
        fs.rmSync(examplesDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      success: false,
      dir: examplesDir,
      message: `Failed to clone examples: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
