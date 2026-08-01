import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { verboseLog, verboseLogLines } from "@/lib/logging";

const GATEWAY_ASSET_NAME = "every-app-gateway-build.tar.gz";

/**
 * Resolve the gateway tarball bundled next to the CLI's built dist directory.
 */
export function resolveBundledGatewayTarballPath(
  moduleUrl: string = import.meta.url,
): string {
  const distDir = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(distDir, "..", "gateway", GATEWAY_ASSET_NAME);
}

/**
 * Extract a tar.gz file
 */
async function extractTarGz(
  archivePath: string,
  destDir: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", archivePath, "-C", destDir]);

    tar.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extraction failed with code ${code}`));
      }
    });
  });
}

/**
 * Walk up from `startDir` to the monorepo dir that contains
 * apps/every-app-gateway, or null if there isn't one.
 */
function findGatewaySourceDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const gatewayPkg = path.join(
      dir,
      "apps",
      "every-app-gateway",
      "package.json",
    );
    if (fs.existsSync(gatewayPkg)) return path.dirname(gatewayPkg);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the gateway release tarball from local monorepo source and extract it.
 *
 * This is the development fallback when the installed CLI package does not
 * contain a bundled gateway. Pass `--localGateway <tarball>` to skip the build
 * and deploy a prebuilt tarball instead.
 */
export async function buildLocalGatewayRelease(
  destDir: string,
  startDir: string,
  verbose: boolean = false,
): Promise<string> {
  const gatewayDir = findGatewaySourceDir(startDir);
  if (!gatewayDir) {
    throw new Error(
      "Could not find apps/every-app-gateway from the current directory. Run " +
        "`everyapp gateway deploy` from inside the monorepo, or pass " +
        "--localGateway <tarball> to deploy a prebuilt gateway.",
    );
  }
  const repoRoot = path.resolve(gatewayDir, "..", "..");

  console.log("Building gateway from local source...");
  const stdio = verbose ? "inherit" : "pipe";
  // The gateway build resolves @every-app/sdk/internal from the SDK's dist/, so
  // the SDK must be built before the gateway's own build.
  await execa("pnpm", ["--filter", "@every-app/sdk", "build"], {
    cwd: repoRoot,
    stdio,
  });
  await execa("pnpm", ["run", "build:release"], { cwd: gatewayDir, stdio });

  const tarball = path.join(gatewayDir, GATEWAY_ASSET_NAME);
  if (!fs.existsSync(tarball)) {
    throw new Error(`Gateway build did not produce ${tarball}`);
  }

  fs.mkdirSync(destDir, { recursive: true });
  verboseLogLines(
    verbose,
    `Built tarball: ${tarball}`,
    "Extracting archive...",
  );
  await extractTarGz(tarball, destDir);
  verboseLog(verbose, "Extraction complete\n");
  return destDir;
}

/**
 * Extract the gateway tarball bundled with the published CLI package.
 */
export async function extractBundledGatewayRelease(
  destDir: string,
  verbose: boolean = false,
): Promise<string | null> {
  const tarballPath = resolveBundledGatewayTarballPath();
  if (!fs.existsSync(tarballPath)) {
    return null;
  }

  console.log("Using bundled gateway...");
  fs.mkdirSync(destDir, { recursive: true });
  verboseLogLines(verbose, `Tarball: ${tarballPath}`, "Extracting archive...");
  await extractTarGz(tarballPath, destDir);
  verboseLog(verbose, "Extraction complete\n");
  return destDir;
}

/**
 * Extract a prebuilt gateway tarball supplied via --localGateway.
 */
export async function extractLocalGatewayTarball(
  tarballPath: string,
  destDir: string,
  verbose: boolean = false,
): Promise<string> {
  console.log("Using local gateway tarball...");

  if (!fs.existsSync(tarballPath)) {
    throw new Error(`Local gateway tarball not found: ${tarballPath}`);
  }

  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  verboseLogLines(verbose, `Tarball: ${tarballPath}`, "Extracting archive...");

  // Extract the archive
  await extractTarGz(tarballPath, destDir);

  verboseLog(verbose, "Extraction complete\n");

  return destDir;
}
