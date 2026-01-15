#!/usr/bin/env node
// Build a release tarball for the gateway
// Usage: node scripts/build-release.js

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATEWAY_DIR = dirname(__dirname);
const RELEASE_DIR = join(GATEWAY_DIR, "release-package");
const TARBALL_PATH = join(GATEWAY_DIR, "every-app-gateway-build.tar.gz");

function exec(command, options = {}) {
  console.log(`> ${command}`);
  execSync(command, { stdio: "inherit", cwd: GATEWAY_DIR, ...options });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

async function main() {
  console.log("Building gateway release...");
  console.log(`Gateway directory: ${GATEWAY_DIR}`);

  // Build the gateway
  console.log("\nRunning pnpm build...");
  exec("pnpm run build");

  // Clean up any existing release package
  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });

  // Verify build output exists
  const distDir = join(GATEWAY_DIR, "dist");
  if (!existsSync(distDir)) {
    console.error("ERROR: dist directory not found after build");
    process.exit(1);
  }

  // Copy build artifacts
  console.log("\nCopying build artifacts...");
  mkdirSync(join(RELEASE_DIR, "dist"), { recursive: true });
  cpSync(distDir, join(RELEASE_DIR, "dist"), { recursive: true });
  cpSync(
    join(GATEWAY_DIR, "wrangler.jsonc"),
    join(RELEASE_DIR, "wrangler.jsonc"),
  );
  cpSync(join(GATEWAY_DIR, "package.json"), join(RELEASE_DIR, "package.json"));
  cpSync(
    join(GATEWAY_DIR, "pnpm-lock.yaml"),
    join(RELEASE_DIR, "pnpm-lock.yaml"),
  );
  cpSync(join(GATEWAY_DIR, "drizzle"), join(RELEASE_DIR, "drizzle"), {
    recursive: true,
  });
  cpSync(
    join(GATEWAY_DIR, "drizzle-prod.config.ts"),
    join(RELEASE_DIR, "drizzle-prod.config.ts"),
  );

  // Copy .wrangler/deploy/config.json
  mkdirSync(join(RELEASE_DIR, ".wrangler", "deploy"), { recursive: true });
  cpSync(
    join(GATEWAY_DIR, ".wrangler", "deploy", "config.json"),
    join(RELEASE_DIR, ".wrangler", "deploy", "config.json"),
  );

  // Clean up absolute paths from built wrangler.json
  console.log("\nCleaning up wrangler.json paths...");
  const wranglerConfigPath = join(
    RELEASE_DIR,
    "dist",
    "server",
    "wrangler.json",
  );
  const wranglerConfig = JSON.parse(readFileSync(wranglerConfigPath, "utf-8"));
  delete wranglerConfig.configPath;
  delete wranglerConfig.userConfigPath;
  writeFileSync(wranglerConfigPath, JSON.stringify(wranglerConfig, null, 2));

  // Create tarball (dependencies are installed at deploy time by the CLI)
  console.log("\nCreating tarball...");
  exec(`tar -czf "${TARBALL_PATH}" -C "${RELEASE_DIR}" .`);

  // Show results
  const tarballSize = formatBytes(statSync(TARBALL_PATH).size);
  console.log("\nRelease package created:");
  console.log(`  Tarball: ${TARBALL_PATH}`);
  console.log(`  Size: ${tarballSize}`);
  console.log("\nTo test locally with the CLI, run:");
  console.log(`  npx everyapp gateway deploy --localGateway "${TARBALL_PATH}"`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
