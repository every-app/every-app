/**
 * The starter app: `templates/simple-todo`, shipped inside the everyapp
 * package (scripts/bundle-templates.js copies the repository's tracked
 * files at prepack), so `everyapp setup` and `everyapp app create` need no
 * git clone and no access to the repository. Inside the Every App
 * monorepo, the source template is used.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  updateEveryappManifestId,
  updatePackageJson,
} from "@/commands/app/create/steps/updateConfiguration";
import { copyDirectory } from "@/lib/file-operations";

const STARTER = path.join("templates", "simple-todo");

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

/**
 * The starter template's directory: bundled next to the CLI's dist/, or
 * the monorepo's own. Null when neither is there.
 */
export function starterTemplateDir(
  moduleUrl: string = import.meta.url,
): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const bundled = path.resolve(moduleDir, "..", STARTER);
  if (isStarter(bundled)) return bundled;
  for (let dir = moduleDir; ; dir = path.dirname(dir)) {
    const source = path.join(dir, STARTER);
    if (isStarter(source)) return source;
    if (path.dirname(dir) === dir) return null;
  }
}

function isStarter(dir: string): boolean {
  return fs.existsSync(path.join(dir, "everyapp.config.ts"));
}

/**
 * Copy a template's files, without local state, to `targetDir`. The
 * bundled template ships its .gitignore as `gitignore` (npm never
 * publishes a .gitignore), so it is renamed back.
 */
export async function copyTemplateFiles(
  templateDir: string,
  targetDir: string,
): Promise<void> {
  await copyDirectory(templateDir, targetDir, { exclude: LOCAL_ONLY });
  const shipped = path.join(targetDir, "gitignore");
  const dotted = path.join(targetDir, ".gitignore");
  if (fs.existsSync(shipped) && !fs.existsSync(dotted)) {
    await fs.promises.rename(shipped, dotted);
  }
}

/** Copy the starter to `targetDir` as app `appId`. */
export async function copyStarter({
  templateDir,
  targetDir,
  appId,
}: {
  templateDir: string;
  targetDir: string;
  appId: string;
}): Promise<void> {
  await copyTemplateFiles(templateDir, targetDir);
  await updatePackageJson({ targetDir, appId });
  await updateEveryappManifestId({ targetDir, appId });
}
