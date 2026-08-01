#!/usr/bin/env node
// Build a release tarball for the gateway
// Usage: node scripts/build-release.js

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
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

function scrubBuildArtifacts(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (
      entry.name === ".dev.vars" ||
      (entry.isDirectory() && entry.name === ".vite")
    ) {
      rmSync(entryPath, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      scrubBuildArtifacts(entryPath);
    }
  }
}

function findSecretFiles(directory) {
  const secretFiles = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (
      (entry.isFile() || entry.isSymbolicLink()) &&
      (entry.name === ".dev.vars" || entry.name.startsWith(".env"))
    ) {
      secretFiles.push(entryPath);
    } else if (entry.isDirectory()) {
      secretFiles.push(...findSecretFiles(entryPath));
    }
  }
  return secretFiles;
}

async function main() {
  console.log("Building gateway release...");
  console.log(`Gateway directory: ${GATEWAY_DIR}`);

  // Clean up any existing release package BEFORE the build: a stale
  // release-package/ contains a copied drizzle.config.ts whose ./src import
  // has no src/ next to it, which fails the build's `tsc --noEmit`.
  rmSync(RELEASE_DIR, { recursive: true, force: true });

  // Build the gateway
  console.log("\nRunning pnpm build...");
  exec("pnpm run build");

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
  scrubBuildArtifacts(RELEASE_DIR);

  // The vite plugin stamps "legacy_env" into the generated config, which
  // wrangler >= 4.111 rejects outright. It only ever mirrored the default
  // behavior, so drop it rather than couple the release to old wranglers.
  const generatedConfigPath = join(
    RELEASE_DIR,
    "dist",
    "server",
    "wrangler.json",
  );
  if (existsSync(generatedConfigPath)) {
    const generatedConfig = JSON.parse(
      readFileSync(generatedConfigPath, "utf-8"),
    );
    if ("legacy_env" in generatedConfig) {
      delete generatedConfig.legacy_env;
      writeFileSync(
        generatedConfigPath,
        JSON.stringify(generatedConfig),
        "utf-8",
      );
      console.log("Stripped legacy_env from generated wrangler.json");
    }
  }
  cpSync(
    join(GATEWAY_DIR, "wrangler.jsonc"),
    join(RELEASE_DIR, "wrangler.jsonc"),
  );
  // The release install exists ONLY to run drizzle migrations. The gateway's
  // real dependencies are already bundled into dist/, and its workspace:*
  // deps (@every-app/perimeter, @every-app/sdk) cannot resolve outside this
  // monorepo — shipping them would make `pnpm install` fail in the extracted
  // release AFTER the worker was already deployed, stranding the gateway
  // without migrations. Ship a minimal migration-only package.json instead.
  const fullPackage = JSON.parse(
    readFileSync(join(GATEWAY_DIR, "package.json"), "utf-8"),
  );
  const keepDeps = [
    "drizzle-orm",
    "dotenv",
    "jsonc-parser",
    "@libsql/client",
    "drizzle-kit",
    "wrangler",
    "typescript",
  ];
  // Pin the exact versions installed in this workspace: the release dir runs
  // its own `pnpm install`, and a caret spec would re-resolve to the newest
  // in-range version — a different wrangler than the one the build was made
  // and tested with (this broke a deploy when ^4.53.0 resolved to 4.111.0).
  const installedVersion = (name) => {
    let version;
    try {
      version = JSON.parse(
        readFileSync(
          join(GATEWAY_DIR, "node_modules", name, "package.json"),
          "utf-8",
        ),
      ).version;
    } catch {
      version = undefined;
    }
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
      // Falling back to the source's caret spec would recreate the exact
      // version-drift failure this pinning exists to prevent.
      console.error(
        `ERROR: cannot resolve installed version of "${name}" — run pnpm install first.`,
      );
      process.exit(1);
    }
    return version;
  };
  const pickDeps = (source = {}) =>
    Object.fromEntries(
      Object.entries(source)
        .filter(([name]) => keepDeps.includes(name))
        .map(([name]) => [name, installedVersion(name)]),
    );
  writeFileSync(
    join(RELEASE_DIR, "package.json"),
    JSON.stringify(
      {
        name: fullPackage.name,
        version: fullPackage.version,
        private: true,
        type: fullPackage.type,
        scripts: {
          "db:migrate:prod": fullPackage.scripts["db:migrate:prod"],
        },
        dependencies: {
          ...pickDeps(fullPackage.dependencies),
          ...pickDeps(fullPackage.devDependencies),
        },
      },
      null,
      2,
    ),
  );
  cpSync(join(GATEWAY_DIR, "drizzle"), join(RELEASE_DIR, "drizzle"), {
    recursive: true,
  });
  cpSync(
    join(GATEWAY_DIR, "drizzle-prod.config.ts"),
    join(RELEASE_DIR, "drizzle-prod.config.ts"),
  );
  cpSync(
    join(GATEWAY_DIR, "drizzle.config.ts"),
    join(RELEASE_DIR, "drizzle.config.ts"),
  );

  // The CLI runs a non-interactive `pnpm install` in the extracted release to
  // run migrations. pnpm >=10 blocks dependency build scripts and pnpm 11
  // makes unapproved ones a hard error (ERR_PNPM_IGNORED_BUILDS), so ship an
  // explicit allowlist of the packages that legitimately need them.
  writeFileSync(
    join(RELEASE_DIR, "pnpm-workspace.yaml"),
    [
      "allowBuilds:",
      "  '@prisma/client': true",
      "  better-sqlite3: true",
      "  esbuild: true",
      "  sharp: true",
      "  workerd: true",
      "",
    ].join("\n"),
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

  const secretFiles = findSecretFiles(RELEASE_DIR);
  if (secretFiles.length > 0) {
    console.error(
      `ERROR: secret files remain in release package:\n${secretFiles.join("\n")}`,
    );
    process.exit(1);
  }

  // Create tarball (dependencies are installed at deploy time by the CLI)
  console.log("\nCreating tarball...");
  exec(`tar -czf "${TARBALL_PATH}" -C "${RELEASE_DIR}" .`);

  // The tarball is the artifact; drop the staging directory so it can't
  // pollute later builds or typechecks.
  rmSync(RELEASE_DIR, { recursive: true, force: true });

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
