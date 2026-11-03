/**
 * The app's @every-app/sdk against this everyapp. They ship as one
 * version (scripts/publish-rc.mjs publishes both at once). A mismatch is
 * only a warning: an app re-pins at the next npm publish, and until then
 * it may well deploy with a newer CLI.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { PUBLISHED_VERSION } from "@/lib/app/publishedVersions";
import { findCheckoutRoot } from "@/lib/checkout";
import type { EventSink } from "@/lib/output/events";
import { cliVersion, compareVersions } from "@/lib/version";

/** The app's own @every-app/sdk version, when it has one installed. */
export function appSdkVersion(cwd: string): string | null {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    return (require("@every-app/sdk/package.json") as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

interface Versions {
  /** This everyapp's own version: an SDK at it is this everyapp's (a `link:` to the checkout). */
  cli: string;
  /** The version an app pins: this everyapp's, or from a checkout the newest published one. */
  pin: string;
}

/**
 * From a checkout everyapp says the next release (0.3.0): publish-rc
 * stamps only the published copy. An npm-pinned app is compared with the
 * newest published version then, which it can pin.
 */
function currentVersions(): Versions {
  return { cli: cliVersion, pin: findCheckoutRoot() ? PUBLISHED_VERSION : cliVersion };
}

/** SDK_VERSION_MISMATCH when the app's installed SDK isn't the version it should pin. */
export function warnSdkVersion(cwd: string, out: EventSink, versions: Versions = currentVersions()): void {
  const sdk = appSdkVersion(cwd);
  if (sdk === null || sdk === versions.cli) return;
  const order = compareVersions(sdk, versions.pin);
  if (order === 0) return;
  const against = versions.pin === versions.cli ? "this everyapp" : "the published everyapp";
  out.emit({
    type: "warning",
    code: "SDK_VERSION_MISMATCH",
    message: `This app's @every-app/sdk is ${sdk}, ${order < 0 ? "older" : "newer"} than ${against} (${versions.pin})\nThey are released together: pin both to one version (pnpm add @every-app/sdk@${versions.pin} everyapp@${versions.pin}).`,
    data: { sdkVersion: sdk, cliVersion: versions.cli, pin: versions.pin },
  });
}
