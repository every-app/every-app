#!/usr/bin/env node
// Check if gateway code changed and version was bumped
// Usage: node scripts/check-gateway-version.js
// Exit code 0: No gateway changes or version was bumped
// Exit code 1: Gateway changed but version not bumped

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);
const GATEWAY_PACKAGE_JSON = join(
  ROOT_DIR,
  "apps/every-app-gateway/package.json",
);

function exec(command) {
  return execSync(command, { cwd: ROOT_DIR, encoding: "utf-8" }).trim();
}

function getVersion(content) {
  const match = content.match(/"version":\s*"([^"]+)"/);
  return match ? match[1] : null;
}

async function main() {
  // Determine the base branch to compare against
  // In CI, use GITHUB_BASE_REF; locally, use the default branch (main)
  const baseBranch = process.env.GITHUB_BASE_REF || "main";

  // Check if we're in a git repository with a base branch
  try {
    exec(`git rev-parse --verify origin/${baseBranch}`);
  } catch {
    console.log(
      `Base branch origin/${baseBranch} not found - skipping version check`,
    );
    process.exit(0);
  }

  // Get the list of changed files compared to base branch
  let changedFiles;
  try {
    changedFiles = exec(`git diff --name-only origin/${baseBranch}...HEAD`);
  } catch {
    // If HEAD comparison fails (e.g., detached HEAD), try direct diff
    try {
      changedFiles = exec(`git diff --name-only origin/${baseBranch}`);
    } catch {
      console.log("Could not determine changed files - skipping version check");
      process.exit(0);
    }
  }

  // Check if any gateway files changed
  const gatewayChanged = changedFiles
    .split("\n")
    .some((file) => file.startsWith("apps/every-app-gateway/"));

  if (!gatewayChanged) {
    console.log("No gateway changes detected - version check passed");
    process.exit(0);
  }

  console.log("Gateway changes detected - checking version bump...");

  // Get base branch version
  let baseVersion;
  try {
    const basePackageJson = exec(
      `git show origin/${baseBranch}:apps/every-app-gateway/package.json`,
    );
    baseVersion = getVersion(basePackageJson);
  } catch {
    console.log(
      "Could not get base version (new package?) - version check passed",
    );
    process.exit(0);
  }

  // Get current version
  const currentPackageJson = readFileSync(GATEWAY_PACKAGE_JSON, "utf-8");
  const currentVersion = getVersion(currentPackageJson);

  if (!baseVersion || !currentVersion) {
    console.error("Could not parse version from package.json");
    process.exit(1);
  }

  if (baseVersion === currentVersion) {
    console.error(
      "Error: every-app-gateway code changed but version not bumped",
    );
    console.error(`Current version: ${baseVersion}`);
    console.error(
      "Please update the version in apps/every-app-gateway/package.json",
    );
    process.exit(1);
  }

  console.log(`Version bumped: ${baseVersion} -> ${currentVersion}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
