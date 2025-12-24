import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, execFileSync } from "node:child_process";

// Default location for examples
const DEFAULT_EXAMPLES_DIR = path.join(os.homedir(), ".every-app-mcp", "examples");

// Repository info
const REPO_URL = "https://github.com/every-app/every-app.git";
const SPARSE_PATHS = ["apps", "templates"];

/**
 * Get the examples directory, using environment variable or default location
 */
export function getExamplesDirectory(): string {
  return process.env.EVERY_APP_EXAMPLES_DIR || DEFAULT_EXAMPLES_DIR;
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
 * Uses sparse checkout to only get apps/ and templates/ directories
 */
export async function ensureExamplesExist(): Promise<{
  success: boolean;
  dir: string;
  message: string;
}> {
  const examplesDir = getExamplesDirectory();

  // Check if examples already exist and have content
  if (fs.existsSync(examplesDir)) {
    const hasApps = fs.existsSync(path.join(examplesDir, "apps"));
    const hasTemplates = fs.existsSync(path.join(examplesDir, "templates"));

    if (hasApps || hasTemplates) {
      // Try to update if it's a git repo
      if (fs.existsSync(path.join(examplesDir, ".git"))) {
        try {
          execFileSync("git", ["pull", "--quiet"], {
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
          // Pull failed, but we have existing examples so continue
          return {
            success: true,
            dir: examplesDir,
            message: "Using existing examples (update failed)",
          };
        }
      }

      return {
        success: true,
        dir: examplesDir,
        message: "Using existing examples",
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

    // Use sparse checkout to only get apps/ and templates/
    execFileSync(
      "git",
      ["clone", "--filter=blob:none", "--sparse", REPO_URL, examplesDir],
      { stdio: "ignore", timeout: 120000 }
    );

    execFileSync("git", ["sparse-checkout", "set", ...SPARSE_PATHS], {
      cwd: examplesDir,
      stdio: "ignore",
      timeout: 30000,
    });

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
