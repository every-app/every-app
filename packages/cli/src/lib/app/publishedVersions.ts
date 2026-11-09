/**
 * The version of the two packages a created app depends on,
 * `@every-app/sdk` and `everyapp`, which are published together at one
 * version: `everyapp create` writes `^<version>` for both into an app made
 * outside the checkout, so the app installs them from npm, and the lockfile
 * its first commit records says exactly what it got.
 *
 * It is this everyapp's own version. The repository commits the version it
 * releases (`pnpm release <version>`, scripts/release.mjs, sets it in the
 * SDK's, the CLI's and the Gateway's package.json in one commit), so a
 * checkout says the newest release, and a published CLI says itself.
 */
import { cliVersion } from "@/lib/version";

export const PUBLISHED_VERSION = cliVersion;

/** The packages published at `PUBLISHED_VERSION`. */
const PUBLISHED_PACKAGES = ["@every-app/sdk", "everyapp"] as const;

/** The range a created app takes `name` at, or null for a package that isn't published. */
export function publishedRange(name: string): string | null {
  return (PUBLISHED_PACKAGES as readonly string[]).includes(name) ? `^${PUBLISHED_VERSION}` : null;
}
