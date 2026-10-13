#!/usr/bin/env node
// Bundle the starter app (templates/simple-todo) with the CLI package, so
// `everyapp setup` and `everyapp app create` copy it from the package
// instead of cloning the repository. Only files git tracks are copied: no
// node_modules, local state or build output. npm never publishes a file
// named .gitignore, so it ships as `gitignore` and the copy renames it back
// (src/lib/app/starter.ts).
// Usage: node scripts/bundle-templates.js

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = dirname(__dirname);
const REPO_ROOT = resolve(CLI_DIR, "..", "..");
const TEMPLATES = ["simple-todo"];

rmSync(join(CLI_DIR, "templates"), { recursive: true, force: true });
for (const template of TEMPLATES) {
  const source = join("templates", template);
  const files = execFileSync("git", ["ls-files", "-z", "--", source], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  if (files.length === 0) {
    console.error(`ERROR: git tracks no files in ${source}`);
    process.exit(1);
  }
  for (const file of files) {
    const target = join(CLI_DIR, file.replace(/(^|\/)\.gitignore$/, "$1gitignore"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(REPO_ROOT, file), target);
  }
  console.log(`Bundled ${source}: ${files.length} files`);
}
