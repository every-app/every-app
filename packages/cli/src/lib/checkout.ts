/**
 * The Every App checkout this CLI runs from, if any, and where the
 * starter template and the shipped skills come from: the checkout when
 * everyapp runs from one (`pnpm everyapp`: the template as it is in the
 * tree), otherwise the installed everyapp package (`npx everyapp`: the
 * template packed with it). Either way an app made outside the checkout
 * takes the published packages from npm (lib/app/publishedVersions.ts).
 * The Gateway comes from the checkout too, when there is one
 * (lib/gateway/source.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The checkout's root: up from this module, to the directory with the
 * gateway and the CLI; null when everyapp doesn't run from a checkout.
 */
export function findCheckoutRoot(moduleUrl: string = import.meta.url): string | null {
  const start = path.dirname(fileURLToPath(moduleUrl));
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "apps", "every-app-gateway", "scripts", "build-release.ts")) &&
      fs.existsSync(path.join(dir, "packages", "cli", "package.json"))
    ) {
      return dir;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** The checkout's root, for tests that need the real one. */
export function checkoutRoot(moduleUrl: string = import.meta.url): string {
  const root = findCheckoutRoot(moduleUrl);
  if (root) return root;
  throw new Error("everyapp isn't running from a checkout of the EveryApp repository");
}

/** Where the starter template and the shipped skills come from. */
export interface TemplateSource {
  /** The checkout, when everyapp runs from one; null from an installed package. */
  root: string | null;
  starterDir: string;
  skillsDir: string;
}

/**
 * The checkout's `starter/` and `packages/cli/skills`, or the installed
 * package's `starter/` and `skills/` (packages/cli/scripts/bundle-starter.mjs
 * packs the template into the package at build).
 */
export function templateSource(moduleUrl: string = import.meta.url): TemplateSource {
  const root = findCheckoutRoot(moduleUrl);
  if (root) {
    return {
      root,
      starterDir: path.join(root, "starter"),
      skillsDir: path.join(root, "packages", "cli", "skills"),
    };
  }
  const pkg = packageDir(path.dirname(fileURLToPath(moduleUrl)));
  return { root: null, starterDir: path.join(pkg, "starter"), skillsDir: path.join(pkg, "skills") };
}

/** The package `dir` is in: the nearest directory up with a package.json. */
function packageDir(dir: string): string {
  for (let at = dir; path.dirname(at) !== at; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, "package.json"))) return at;
  }
  return dir;
}

/** `file`'s real path (symlinks followed), or the path resolved when it doesn't exist yet. */
export function realpathOr(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Whether `dir` is the checkout's root or somewhere inside it; never, with no checkout. */
export function isInCheckout(dir: string, root: string | null): boolean {
  if (root === null) return false;
  const relative = path.relative(realpathOr(root), realpathOr(dir));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
