import chalk from "chalk";
import { version as currentVersion } from "../../package.json";

const NPM_REGISTRY_URL =
  "https://registry.npmjs.org/everyapp?fields=dist-tags";
const FETCH_TIMEOUT_MS = 2000;

interface VersionCheckResult {
  updateAvailable: boolean;
  latestVersion?: string;
  currentVersion: string;
}

// Module-level promise for the version check, started on import
let versionCheckPromise: Promise<VersionCheckResult> | null = null;

/**
 * Initializes the version check. Should be called early in CLI startup.
 */
export function initVersionCheck(): void {
  if (!versionCheckPromise) {
    versionCheckPromise = fetchLatestVersion().then((latestVersion) => {
      if (
        latestVersion &&
        latestVersion !== currentVersion &&
        isVersionLessThan(currentVersion, latestVersion)
      ) {
        return {
          updateAvailable: true,
          latestVersion,
          currentVersion,
        };
      }

      return {
        updateAvailable: false,
        currentVersion,
      };
    });
  }
}

/**
 * Waits for version check and prints update notice if available.
 * Safe to call multiple times - will only print once.
 */
let noticePrinted = false;
export async function printUpdateNoticeIfAvailable(): Promise<void> {
  if (noticePrinted || !versionCheckPromise) return;
  noticePrinted = true;

  const result = await versionCheckPromise;
  printUpdateNoticeSync(result);
}

/**
 * Prints update notice (if available) and exits the process.
 * Use this instead of process.exit() to ensure the update notice is shown.
 */
export async function exitWithUpdateNotice(status: number): Promise<never> {
  await printUpdateNoticeIfAvailable();
  process.exit(status);
}

/**
 * Fetches the latest version from npm registry.
 * Returns null if the fetch fails or times out.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      "dist-tags": { latest: string };
    };
    return data["dist-tags"].latest;
  } catch {
    // Silently fail - network issues shouldn't block CLI usage
    return null;
  }
}

/**
 * Compares two semver version strings.
 * Returns true if version a is less than version b.
 */
function isVersionLessThan(a: string, b: string): boolean {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;

    if (numA < numB) return true;
    if (numA > numB) return false;
  }

  return false;
}

/**
 * Prints an update notice if an update is available.
 */
function printUpdateNoticeSync(result: VersionCheckResult): void {
  if (result.updateAvailable && result.latestVersion) {
    console.log();
    console.log(
      chalk.yellow(
        `  Update available: ${result.currentVersion} → ${result.latestVersion}`,
      ),
    );
    console.log(
      chalk.dim(`  Run latest: ${chalk.cyan("npx -y everyapp@latest")}`),
    );
  }
}
