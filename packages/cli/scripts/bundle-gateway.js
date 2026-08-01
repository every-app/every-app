#!/usr/bin/env node
// Build the gateway release tarball and bundle it with the CLI package
// Usage: node scripts/bundle-gateway.js

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = dirname(__dirname);
const REPO_ROOT = resolve(CLI_DIR, "..", "..");
const GATEWAY_DIR = join(REPO_ROOT, "apps", "every-app-gateway");
const GATEWAY_ASSET_NAME = "every-app-gateway-build.tar.gz";
const SOURCE_TARBALL = join(GATEWAY_DIR, GATEWAY_ASSET_NAME);
const BUNDLE_DIR = join(CLI_DIR, "gateway");
const BUNDLED_TARBALL = join(BUNDLE_DIR, GATEWAY_ASSET_NAME);

function exec(command, cwd) {
  console.log(`> ${command}`);
  execSync(command, { cwd, stdio: "inherit" });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

async function main() {
  rmSync(BUNDLE_DIR, { recursive: true, force: true });

  console.log("Building SDK...");
  exec("pnpm --filter @every-app/sdk build", REPO_ROOT);

  console.log("\nBuilding gateway release...");
  exec("pnpm run build:release", GATEWAY_DIR);

  if (!existsSync(SOURCE_TARBALL)) {
    console.error(`ERROR: gateway build did not produce ${SOURCE_TARBALL}`);
    process.exit(1);
  }

  mkdirSync(BUNDLE_DIR, { recursive: true });
  copyFileSync(SOURCE_TARBALL, BUNDLED_TARBALL);

  console.log("\nBundled gateway release:");
  console.log(`  Tarball: ${BUNDLED_TARBALL}`);
  console.log(`  Size: ${formatBytes(statSync(BUNDLED_TARBALL).size)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
