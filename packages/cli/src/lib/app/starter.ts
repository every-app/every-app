/**
 * The starter app, `templates/simple-todo` in the checkout this CLI runs
 * from, and where `everyapp create` puts a copy of it: in the
 * checkout's apps/, a workspace package like the example apps, when it
 * runs inside the checkout; in the current directory anywhere else.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  updateEveryappManifest,
  updatePackageJson,
  updateReadme,
} from "@/commands/create/steps/updateConfiguration";
import { isInCheckout } from "@/lib/checkout";
import { copyDirectory } from "@/lib/file-operations";

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
  return path.join(root, "templates", "simple-todo");
}

/** Where app create puts app `appId` when run from `cwd`. */
export function newAppDir({
  appId,
  cwd,
  root,
}: {
  appId: string;
  cwd: string;
  root: string;
}): string {
  return isInCheckout(cwd, root)
    ? path.join(root, "apps", appId)
    : path.join(cwd, appId);
}

/**
 * What an app outside the checkout installs with: it is its own pnpm
 * workspace there, and pnpm runs no dependency build scripts but these.
 * Inside, the checkout's pnpm-workspace.yaml allows them.
 */
const STANDALONE_WORKSPACE = "allowBuilds:\n  esbuild: true\n  workerd: true\n";

/** Copy the starter, without local state, to `targetDir` as app `appId`. */
export async function copyStarter({
  root,
  targetDir,
  appId,
}: {
  /** The checkout the template and the packages it links come from. */
  root: string;
  targetDir: string;
  appId: string;
}): Promise<void> {
  await copyDirectory(starterTemplateDir(root), targetDir, { exclude: LOCAL_ONLY });
  if (!isInCheckout(targetDir, root)) {
    await fs.writeFile(path.join(targetDir, "pnpm-workspace.yaml"), STANDALONE_WORKSPACE);
  }
  await updatePackageJson({ targetDir, appId, root });
  await updateEveryappManifest({ targetDir, appId });
  await updateReadme({ targetDir, appId });
}
