import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { verboseLog, verboseLogLines } from "@/lib/logging";

const REPO_OWNER = "every-app";
const REPO_NAME = "every-app";
const GATEWAY_ASSET_NAME = "every-app-gateway-build.tar.gz";

/**
 * Get the download URL for the latest gateway release
 */
function getLatestGatewayReleaseUrl(): string {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/gateway-latest/${GATEWAY_ASSET_NAME}`;
}

/**
 * Download a file from a URL
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(
      `Failed to download file: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const fileStream = createWriteStream(destPath);
  const nodeStream = Readable.fromWeb(response.body);
  await pipeline(nodeStream, fileStream);
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
 * Download and extract the latest gateway release
 */
export async function downloadLatestGatewayRelease(
  destDir: string,
  verbose: boolean = false,
): Promise<string> {
  console.log("Getting latest gateway release...");

  // Create destination directory
  fs.mkdirSync(destDir, { recursive: true });

  const url = getLatestGatewayReleaseUrl();

  verboseLog(verbose, `URL: ${url}`);

  // Download the archive
  const archivePath = path.join(destDir, GATEWAY_ASSET_NAME);

  try {
    await downloadFile(url, archivePath);
  } catch (error) {
    if (error instanceof Error && error.message.includes("404")) {
      throw new Error(
        "Gateway release not found. Make sure a release has been published.",
      );
    }
    throw error;
  }

  verboseLogLines(
    verbose,
    `Downloaded to: ${archivePath}`,
    "Extracting archive...",
  );

  // Extract the archive
  await extractTarGz(archivePath, destDir);

  // Clean up the archive
  fs.unlinkSync(archivePath);

  verboseLog(verbose, "Extraction complete\n");

  return destDir;
}

/**
 * Extract a local gateway tarball (for testing)
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
