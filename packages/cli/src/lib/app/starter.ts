/**
 * The starter app, `starter/` in the checkout this CLI runs from or
 * packed into the installed everyapp package (lib/checkout.ts
 * `templateSource`), and where `everyapp create` puts a copy of it:
 * apps/<id> in the checkout, as a workspace package, when it runs inside
 * the checkout; ./<id> in the current directory anywhere else (always,
 * from an installed package); or the directory a path argument names,
 * which is one of those two places or is refused.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  updateEveryappManifest,
  updatePackageJson,
  updateReadme,
} from "@/commands/create/steps/updateConfiguration";
import { isInCheckout, realpathOr, type TemplateSource } from "@/lib/checkout";
import { copyDirectory, fileExists } from "@/lib/file-operations";

/** Never copied into a new app: local state, build output, installs. */
const LOCAL_ONLY = [
  "node_modules",
  ".git",
  "pnpm-lock.yaml",
  "package-lock.json",
  ".env",
  ".env.local",
  ".env.production",
  ".dev.vars",
  ".cloudflare",
  ".everyapp",
  ".wrangler",
  ".output",
  ".tanstack",
  "dist",
  "manual-steps.md",
];

/** The starter template's directory in the checkout. */
export function starterTemplateDir(root: string): string {
  return path.join(root, "starter");
}

/** Where app create puts app `appId` when run from `cwd` with a bare name. */
export function newAppDir({
  appId,
  cwd,
  root,
}: {
  appId: string;
  cwd: string;
  root: string | null;
}): string {
  return root !== null && isInCheckout(cwd, root)
    ? path.join(root, "apps", appId)
    : path.join(cwd, appId);
}

/**
 * Where `dir` stands to the checkout at `root`: outside it (an app there is
 * its own repository), directly in its apps/ (where an app inside the
 * checkout belongs), or somewhere else inside it (refused by create).
 */
export function placeOf(dir: string, root: string | null): "outside" | "apps" | "inside" {
  if (root === null || !isInCheckout(dir, root)) return "outside";
  const parent = realpathOr(path.dirname(dir));
  return parent === realpathOr(path.join(root, "apps")) ? "apps" : "inside";
}

/**
 * What an app outside the checkout installs with: it is its own pnpm
 * workspace there, and pnpm runs no dependency build scripts but these
 * (the ones the checkout's pnpm-workspace.yaml allows; without the list,
 * every `pnpm install` warns about ignored build scripts). Inside, the
 * checkout's pnpm-workspace.yaml covers the app.
 */
const STANDALONE_WORKSPACE = "allowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\n";

/**
 * A packed template keeps its .gitignore as `gitignore` (npm would drop
 * the dotfile from the package); the copy gets the dot back.
 */
const PACKED_GITIGNORE = "gitignore";

/** Copy the starter, without local state, to `targetDir` as app `appId`. */
export async function copyStarter({
  source,
  targetDir,
  appId,
  version,
}: {
  /** The template, and the checkout the packages are linked from, if any. */
  source: TemplateSource;
  targetDir: string;
  appId: string;
  /** This everyapp's version: what an app made from a package pins. */
  version: string;
}): Promise<void> {
  const { root } = source;
  await copyDirectory(source.starterDir, targetDir, { exclude: LOCAL_ONLY });
  const packed = path.join(targetDir, PACKED_GITIGNORE);
  if (await fileExists(packed)) await fs.rename(packed, path.join(targetDir, ".gitignore"));
  if (!isInCheckout(targetDir, root)) {
    await fs.writeFile(path.join(targetDir, "pnpm-workspace.yaml"), STANDALONE_WORKSPACE);
  }
  await updatePackageJson({ targetDir, appId, root, version });
  await updateEveryappManifest({ targetDir, appId });
  await updateReadme({ targetDir, appId });
}
