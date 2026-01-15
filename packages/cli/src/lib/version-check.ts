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
 * Starts a non-blocking version check.
 * Returns a promise that resolves to the check result.
 */
export function startVersionCheck(): Promise<VersionCheckResult> {
  return fetchLatestVersion().then((latestVersion) => {
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

/**
 * Prints an update notice if an update is available.
 */
export function printUpdateNotice(result: VersionCheckResult): void {
  if (result.updateAvailable && result.latestVersion) {
    console.log();
    console.log(
      chalk.yellow(`  Update available: ${result.currentVersion} → ${result.latestVersion}`)
    );
    console.log(
      chalk.dim(`  npx:    ${chalk.cyan("npx everyapp@latest")}`)
    );
    console.log(
      chalk.dim(`  global: ${chalk.cyan("npm update -g everyapp")}`)
    );
  }
}
