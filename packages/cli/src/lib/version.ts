/**
 * This everyapp's name and version, read from its own package.json when it
 * runs, never baked in at build time. The version is committed now
 * (`pnpm release`, scripts/release.mjs), but reading it at run time keeps
 * one rule for every build: a version tsup inlined at build drifted from
 * what npm published once: on
 * 2026-10-26 the published 0.3.0-rc.6 said `everyapp 0.3.0` and asked for
 * the Gateway release gateway-v0.3.0, which doesn't exist.
 *
 * The package.json is the nearest one up from this module named
 * `everyapp`: `<package>/package.json` from the built `dist/` (a flat
 * directory of chunks) and `packages/cli/package.json` from the source.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCheckoutRoot } from "./checkout";

interface CliPackage {
  name: string;
  version: string;
}

/** The everyapp package.json up from `moduleUrl`. */
export function readCliPackage(moduleUrl: string = import.meta.url): CliPackage {
  for (let dir = path.dirname(fileURLToPath(moduleUrl)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CliPackage>;
      if (pkg.name === "everyapp" && typeof pkg.version === "string") {
        return { name: pkg.name, version: pkg.version };
      }
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`everyapp can't find its own package.json above ${fileURLToPath(moduleUrl)}`);
    }
  }
}

const cliPackage = readCliPackage();

/** `everyapp`. */
const cliName = cliPackage.name;
/** This everyapp's version, as its package.json says now. */
export const cliVersion = cliPackage.version;

/**
 * The commit of the checkout this everyapp runs from (8 characters), so
 * `--version` tells a checkout's everyapp from the published one of the
 * same version; null from an installed package, or when git can't say.
 */
export function checkoutCommit(root: string | null = findCheckoutRoot()): string | null {
  if (!root) return null;
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{8,}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** `everyapp 0.3.0`, or from a checkout `everyapp 0.3.0 (checkout 6afd18bb)`. */
export function versionLine(commit: string | null = checkoutCommit()): string {
  return `${cliName} ${cliVersion}${commit ? ` (checkout ${commit})` : ""}`;
}

/**
 * Semver order, prerelease included: 0.3.0-rc.9 < 0.3.0-rc.10 < 0.3.0.
 * Negative when `a` is older. A leading `v` is ignored; build metadata
 * (`+…`) doesn't order.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string) => {
    const [core = "", ...pre] = version.trim().replace(/^v/, "").split("+")[0]!.split("-");
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre.length > 0 ? pre.join("-").split(".") : [],
    };
  };
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(left.core.length, right.core.length, 3); i += 1) {
    const difference = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (difference !== 0) return difference;
  }
  // A release sorts after its prereleases.
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const [x, y] = [left.pre[i], right.pre[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y);
      if (difference !== 0) return difference;
    } else if (xNumeric !== yNumeric) {
      // Numeric identifiers sort before alphanumeric ones.
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
