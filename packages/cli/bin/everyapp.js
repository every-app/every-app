#!/usr/bin/env node
// Committed launcher so package managers can link the bin at install time,
// before dist/ exists (fresh CI checkouts install with --ignore-scripts).
//
// everyapp runs from a checkout of the Every App repository: nothing is
// published while we work from the repository (.github/RELEASE.md). So when
// the CLI's source, or the SDK, perimeter or toolbus it bundles, changed
// since dist/ was built, it is rebuilt first: a few seconds, and only after
// a change, so `everyapp` always runs the code in front of you.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.dirname(cliDir);
const sdkDir = path.join(packagesDir, "sdk");

/** When `file` was last written, in ms; 0 when it doesn't exist. */
function writtenAt(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/** The newest write to any of `entries` (files, or directories walked whole), tests aside. */
function newestWrite(entries) {
  let newest = 0;
  for (const entry of entries) {
    const stat = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isDirectory()) {
      newest = Math.max(newest, stat.mtimeMs);
      continue;
    }
    for (const file of fs.readdirSync(entry, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || file.name.endsWith(".test.ts")) continue;
      newest = Math.max(newest, writtenAt(path.join(file.parentPath, file.name)));
    }
  }
  return newest;
}

function rebuild(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0) return;
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.error(
    `everyapp: couldn't rebuild from this checkout: \`${[command, ...args].join(" ")}\` in ${cwd} ${result.error ? `failed (${result.error.message})` : `exited ${result.status}`}.`,
  );
  process.exit(1);
}

// Only in a checkout: a packed CLI has dist/ and no source.
if (fs.existsSync(path.join(cliDir, "src")) && fs.existsSync(path.join(sdkDir, "src"))) {
  const sdkBuilt = writtenAt(path.join(sdkDir, "dist", "server", "index.js"));
  const sdkStale =
    newestWrite([
      path.join(sdkDir, "src"),
      path.join(sdkDir, "package.json"),
      path.join(sdkDir, "tsconfig.json"),
      path.join(sdkDir, "tsconfig.build.json"),
    ]) > sdkBuilt;
  const cliStale =
    sdkStale ||
    newestWrite([
      path.join(cliDir, "src"),
      path.join(cliDir, "package.json"),
      path.join(cliDir, "tsconfig.json"),
      path.join(packagesDir, "perimeter", "src"),
      path.join(packagesDir, "perimeter", "package.json"),
      path.join(packagesDir, "toolbus", "src"),
      path.join(packagesDir, "toolbus", "package.json"),
      path.join(sdkDir, "dist"),
    ]) > writtenAt(path.join(cliDir, "dist", "index.js"));
  if (cliStale) {
    // The CLI bundles the SDK from its dist/, and apps load it from there too.
    if (sdkStale) rebuild("pnpm", ["run", "build"], sdkDir);
    // tsup alone, no type check: `pnpm -C packages/cli build` type-checks.
    rebuild("pnpm", ["exec", "tsup", "--silent"], cliDir);
    const commit = spawnSync("git", ["describe", "--always", "--dirty", "--exclude=*"], { cwd: cliDir, encoding: "utf8" }).stdout.trim();
    console.error(styleText("dim", `Updated everyapp CLI to ${commit}`, { stream: process.stderr }));
  }
}

import("../dist/index.js").catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "everyapp CLI is not built. In the monorepo, run: pnpm -C packages/cli build",
    );
    process.exit(1);
  }
  throw error;
});
