/**
 * The published version of the two packages a created app depends on,
 * `@every-app/sdk` and `everyapp`, which are published together at the
 * same version: `everyapp create` writes `^<version>` for both into an
 * app made outside the checkout (from a checkout or from an everyapp
 * installed with npm), so the app installs them from npm, and the
 * lockfile its first commit records says exactly what it got.
 *
 * A constant, not the CLI's own package.json version: the repository's
 * package.json files name the next release (0.3.0) while its rcs are
 * published under the dist-tag `next`. Set it to the version about to be
 * published, before publishing (.github/RELEASE.md). `^0.3.0-rc.5` admits
 * the later rcs and 0.3.0, never 0.4.0.
 */
export const PUBLISHED_VERSION = "0.3.0-rc.5";

/** The packages published at `PUBLISHED_VERSION`. */
export const PUBLISHED_PACKAGES = ["@every-app/sdk", "everyapp"] as const;

/** The range a created app takes `name` at, or null for a package that isn't published. */
export function publishedRange(name: string): string | null {
  return (PUBLISHED_PACKAGES as readonly string[]).includes(name) ? `^${PUBLISHED_VERSION}` : null;
}
