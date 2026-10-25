/**
 * The Every App checkout this CLI runs from, if any. Nothing is published
 * to npm while we work from the repository (.github/RELEASE.md), so the
 * starter template and the packages a new app links to come from the
 * checkout the running everyapp was built in, wherever it runs. The
 * Gateway is built from it too (lib/gateway/checkoutRelease.ts); there is
 * no other source while publishing is paused.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EveryAppError } from "@/lib/errors";

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

/** The checkout's root, for what only a checkout has (the starter template). */
export function checkoutRoot(moduleUrl: string = import.meta.url): string {
  const root = findCheckoutRoot(moduleUrl);
  if (root) return root;
  throw new EveryAppError(
    "CHECKOUT_MISSING",
    `everyapp has to run from a checkout of the Every App repository\nThis copy is installed in ${packageDir(path.dirname(fileURLToPath(moduleUrl)))}, outside any checkout.`,
    { fix: `in your checkout, run pnpm everyapp ${process.argv.slice(2).join(" ")}`.trimEnd() },
  );
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

/** Whether `dir` is the checkout's root or somewhere inside it. */
export function isInCheckout(dir: string, root: string = checkoutRoot()): boolean {
  const relative = path.relative(realpathOr(root), realpathOr(dir));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
