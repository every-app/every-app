/**
 * The one release version, and every file that carries it. The SDK, the
 * CLI and the Gateway are released together at one version, committed in
 * the repository (`pnpm release <version>` writes it; a CLI test checks
 * they agree: packages/cli/src/lib/app/publishedVersions.test.ts).
 */
import fs from "node:fs";
import path from "node:path";

/** The package.json files whose `version` is the release version. */
export const PACKAGE_JSONS = [
  "packages/sdk/package.json",
  "packages/cli/package.json",
  "apps/every-app-gateway/package.json",
];

/** The SDK reports its version with every catalog; it can't read package.json in a Worker. */
export const SDK_VERSION_FILE = "packages/sdk/src/server/tools.ts";
const SDK_VERSION_PATTERN = /export const SDK_VERSION = "([^"]*)";/;

/** What gets published to npm, in order: the SDK first (the CLI's new apps depend on it). */
export const PUBLISHED = [
  { dir: "packages/sdk", name: "@every-app/sdk" },
  { dir: "packages/cli", name: "everyapp" },
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function isVersion(value) {
  return typeof value === "string" && SEMVER.test(value);
}

/** Negative when a sorts before b, as semver orders them (a release after its prereleases). */
export function compareVersions(a, b) {
  const [, ...left] = SEMVER.exec(a) ?? [];
  const [, ...right] = SEMVER.exec(b) ?? [];
  if (left.length === 0 || right.length === 0) throw new Error(`not a version: ${left.length ? b : a}`);
  for (let i = 0; i < 3; i += 1) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference !== 0) return difference;
  }
  const [x, y] = [left[3], right[3]];
  if (x === undefined || y === undefined) return (x === undefined ? 1 : 0) - (y === undefined ? 1 : 0);
  const [xs, ys] = [x.split("."), y.split(".")];
  for (let i = 0; i < Math.max(xs.length, ys.length); i += 1) {
    if (xs[i] === undefined) return -1;
    if (ys[i] === undefined) return 1;
    const [xn, yn] = [/^\d+$/.test(xs[i]), /^\d+$/.test(ys[i])];
    if (xn && yn && Number(xs[i]) !== Number(ys[i])) return Number(xs[i]) - Number(ys[i]);
    if (xn !== yn) return xn ? -1 : 1;
    if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1;
  }
  return 0;
}

/**
 * The version after `current`: `patch`, `minor`, `major`, or an exact
 * version. `patch` of a prerelease is its release (0.3.0-rc.15 → 0.3.0), as
 * semver's own increment does. Throws unless the result is newer.
 */
export function nextVersion(current, how) {
  const [, major, minor, patch, pre] = SEMVER.exec(current) ?? [];
  if (major === undefined) throw new Error(`the current version isn't a version: ${current}`);
  const [M, m, p] = [Number(major), Number(minor), Number(patch)];
  let next;
  if (how === "patch") next = pre ? `${M}.${m}.${p}` : `${M}.${m}.${p + 1}`;
  else if (how === "minor") next = pre && p === 0 ? `${M}.${m}.0` : `${M}.${m + 1}.0`;
  else if (how === "major") next = pre && m === 0 && p === 0 ? `${M}.0.0` : `${M + 1}.0.0`;
  else if (isVersion(how)) next = how;
  else throw new Error(`"${how}" isn't patch, minor, major or a version like 0.3.1`);
  if (compareVersions(next, current) <= 0) {
    throw new Error(`${next} isn't newer than the current version, ${current}`);
  }
  return next;
}

/** Each file's version, keyed by its path from the root. */
export function readVersions(root) {
  const versions = {};
  for (const file of PACKAGE_JSONS) {
    versions[file] = JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).version;
  }
  versions[SDK_VERSION_FILE] = SDK_VERSION_PATTERN.exec(fs.readFileSync(path.join(root, SDK_VERSION_FILE), "utf8"))?.[1];
  return versions;
}

/** The one version every file says; throws, naming them, when they disagree. */
export function currentVersion(root) {
  const versions = readVersions(root);
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1 || !isVersion([...distinct][0])) {
    const lines = Object.entries(versions).map(([file, version]) => `  ${file}: ${version}`);
    throw new Error(`the release version isn't the same everywhere:\n${lines.join("\n")}`);
  }
  return [...distinct][0];
}

/** Writes `version` into every file, changing nothing else in them. */
export function writeVersion(root, version) {
  if (!isVersion(version)) throw new Error(`not a version: ${version}`);
  for (const file of PACKAGE_JSONS) {
    const full = path.join(root, file);
    const text = fs.readFileSync(full, "utf8");
    const updated = text.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
    if (updated === text && !text.includes(`"version": "${version}"`)) throw new Error(`no version in ${file}`);
    fs.writeFileSync(full, updated);
  }
  const full = path.join(root, SDK_VERSION_FILE);
  const text = fs.readFileSync(full, "utf8");
  if (!SDK_VERSION_PATTERN.test(text)) throw new Error(`no SDK_VERSION in ${SDK_VERSION_FILE}`);
  fs.writeFileSync(full, text.replace(SDK_VERSION_PATTERN, `export const SDK_VERSION = "${version}";`));
}
