/**
 * The Every App checkout this CLI runs from. Nothing is published while we
 * work from the repository (.github/RELEASE.md), so the gateway release,
 * the starter template and the packages a new app links to all come from
 * the checkout the running everyapp was built in, wherever it runs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EveryAppError } from "@/lib/errors";

/** The checkout's root: up from this module, to the directory with the gateway and the CLI. */
export function checkoutRoot(moduleUrl: string = import.meta.url): string {
  const start = path.dirname(fileURLToPath(moduleUrl));
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "apps", "every-app-gateway", "scripts", "build-release.ts")) &&
      fs.existsSync(path.join(dir, "packages", "cli", "package.json"))
    ) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new EveryAppError(
        "CHECKOUT_MISSING",
        `everyapp runs from a checkout of the Every App repository, and ${start} isn't in one. Run it from the repository: pnpm everyapp …`,
      );
    }
  }
}

/** Whether `dir` is the checkout's root or somewhere inside it. */
export function isInCheckout(dir: string, root: string = checkoutRoot()): boolean {
  const real = (file: string) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const relative = path.relative(real(root), real(dir));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}
