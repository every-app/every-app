#!/usr/bin/env node
// Committed launcher so package managers can link the bin at install time,
// before dist/ exists (fresh CI checkouts install with --ignore-scripts).
//
// everyapp runs from a checkout of the Every App repository: nothing is
// published while we work from the repository (.github/RELEASE.md). So when
// the CLI's source, or the SDK, perimeter or toolbus it bundles, changed
// since dist/ was built, it is rebuilt first: a few seconds, and only after
// a change, so `everyapp` always runs the code in front of you. And when
// pnpm-lock.yaml changed since the checkout's last install (a `git pull`
// that moved a dependency), the dependencies are installed first, so
// `git pull` is all it takes to run today's code.
//
// Dependency-free, and nothing newer than Node 18 runs before the Node
// check below: an old Node must reach the friendly message, not a
// SyntaxError. (src/bin/launcher.test.ts holds the imports to that.)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The Node this needs, said as src/lib/runtime.ts says it (the launcher
// can't import src): cf loads cloudflare.config.ts with Node's built-in
// TypeScript stripping, which Node gained in 22.18.0.
const MIN_NODE_VERSION = "22.18.0";

/** Whether `version` is older than `minimum` (both "major.minor.patch", a leading v allowed). */
function olderThan(version, minimum) {
  const parse = (value) =>
    value
      .replace(/^v/, "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0);
  }
  return false;
}

// Colors as the CLI decides them (src/lib/output/terminal.ts): never with
// NO_COLOR, only at a terminal that isn't dumb; FORCE_COLOR decides alone.
const colors =
  process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== "0"
    : Boolean(process.stderr.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const dim = (text) => (colors ? `\x1b[2m${text}\x1b[22m` : text);
const red = (text) => (colors ? `\x1b[31m${text}\x1b[39m` : text);
const bold = (text) => (colors ? `\x1b[1m${text}\x1b[22m` : text);

/**
 * Stop with one problem, said as the CLI says its own (src/lib/output):
 * one `error` event on stdout under --json, else a headline, its detail
 * dim, then the fix and the command to run.
 */
function fail({ code, message, fix, rerun }) {
  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        ts: new Date().toISOString(),
        type: "error",
        code,
        message,
        retryable: false,
        data: { ...(fix ? { fix } : {}), ...(rerun ? { rerun } : {}) },
      })}\n`,
    );
  } else {
    const [headline, ...detail] = message.split("\n");
    process.stderr.write(
      [
        `${red("✗")} ${headline}`,
        ...detail.map((line) => dim(`  ${line}`)),
        ...(fix ? [`  Fix: ${fix}`] : []),
        ...(rerun ? [`  Run: ${bold(rerun)}`] : []),
        "",
      ].join("\n"),
    );
  }
  process.exit(1);
}

if (olderThan(process.versions.node, MIN_NODE_VERSION)) {
  fail({
    code: "UNSUPPORTED_RUNTIME",
    message: `everyapp needs Node.js ${MIN_NODE_VERSION} or newer; this is ${process.versions.node}\nThe Cloudflare CLI loads cloudflare.config.ts with Node's built-in TypeScript support.`,
    fix: "install Node 22 or 24, then run the command again",
  });
}

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packagesDir = path.dirname(cliDir);
const sdkDir = path.join(packagesDir, "sdk");
const rootDir = path.dirname(packagesDir);
// Only in a checkout: a packed CLI has dist/ and no source, so nothing
// below (the install, the rebuild) ever runs for an installed everyapp.
const inCheckout = fs.existsSync(path.join(cliDir, "src")) && fs.existsSync(path.join(sdkDir, "src"));

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

/** Which of the SDK and the CLI changed since their dist/ was built. */
function staleness() {
  const sdkBuilt = writtenAt(path.join(sdkDir, "dist", "server", "index.js"));
  const sdk =
    newestWrite([
      path.join(sdkDir, "src"),
      path.join(sdkDir, "package.json"),
      path.join(sdkDir, "tsconfig.json"),
      path.join(sdkDir, "tsconfig.build.json"),
    ]) > sdkBuilt;
  const cli =
    sdk ||
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
  return { sdk, cli };
}

/**
 * Run one build command; whether it succeeded. A failure prints the build's
 * output and what failed, and is reported rather than exited on: the caller
 * holds the rebuild lock, and process.exit would skip the finally that
 * releases it.
 */
function rebuild(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status === 0) return true;
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.error(
    `everyapp: couldn't rebuild from this checkout: \`${[command, ...args].join(" ")}\` in ${cwd} ${result.error ? `failed (${result.error.message})` : `exited ${result.status}`}.`,
  );
  return false;
}

// The checkout's dependencies follow its lockfile. What says they do is a
// stamp: the SHA-256 of the pnpm-lock.yaml the last install was made from,
// written once that install succeeded. A lockfile that hashes to the stamp
// needs nothing, however often it is asked, so an install never repeats.
// An install made by hand writes no stamp, so node_modules written after
// the lockfile (pnpm's .modules.yaml) counts as that install and is stamped.
const LOCKFILE = path.join(rootDir, "pnpm-lock.yaml");
const INSTALL_STAMP = path.join(rootDir, "node_modules", ".cache", "everyapp", "installed-lockfile");
const INSTALL_COMMAND = `pnpm -C ${rootDir} install`;
// Off in CI (it installs for itself, and must fail rather than repair), and
// with EVERYAPP_AUTO_INSTALL=0.
const autoInstall = !process.env.CI && !["0", "false"].includes(process.env.EVERYAPP_AUTO_INSTALL ?? "");

function stampInstall(hash) {
  fs.mkdirSync(path.dirname(INSTALL_STAMP), { recursive: true });
  fs.writeFileSync(INSTALL_STAMP, `${hash}\n`);
}

/** The lockfile's hash when the checkout's dependencies must be installed from it; null when they are. */
function pendingInstall() {
  if (!autoInstall || !fs.existsSync(LOCKFILE)) return null;
  const hash = createHash("sha256").update(fs.readFileSync(LOCKFILE)).digest("hex");
  let stamped = null;
  try {
    stamped = fs.readFileSync(INSTALL_STAMP, "utf8").trim();
  } catch {
    // No install recorded yet.
  }
  if (stamped === hash) return null;
  const installedAt = writtenAt(path.join(rootDir, "node_modules", ".modules.yaml"));
  if (installedAt > 0 && installedAt >= writtenAt(LOCKFILE)) {
    stampInstall(hash);
    return null;
  }
  return hash;
}

/** `pnpm install --frozen-lockfile` in the checkout's root; null when it worked, else what it exited with. */
function installDependencies() {
  const result = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: rootDir, encoding: "utf8" });
  if (result.status === 0) return null;
  process.stderr.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result.error ? `failed (${result.error.message})` : `exited ${result.status}`;
}

// One rebuild at a time per checkout. Two everyapps started together (an
// agent running commands in parallel, two terminals) would both rebuild,
// and one would trip over the files the other just cleaned. The lock is a
// directory under the checkout's build cache: mkdir without `recursive` is
// atomic, so EEXIST means another process holds it. The holder writes its
// pid; a lock older than 5 minutes, or whose holder is gone, is taken over.
const LOCK_DIR = path.join(path.dirname(packagesDir), "node_modules", ".cache", "everyapp", "rebuild.lock");
const LOCK_STALE_MS = 5 * 60_000;
const LOCK_POLL_MS = 200;

/** Whether the lock at `lockDir` was left behind: too old, or its holder is gone. */
function abandoned(lockDir) {
  const stat = fs.statSync(lockDir, { throwIfNoEntry: false });
  if (!stat) return false;
  if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) return true;
  let pid;
  try {
    pid = Number.parseInt(fs.readFileSync(path.join(lockDir, "pid"), "utf8"), 10);
  } catch {
    // Just made, its pid not written yet: the age rule covers a holder that died here.
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `build` holding the rebuild lock, unless `stillNeeded` says the wait
 * made it moot; what `build` returned, or true when nothing was needed.
 * The lock is released on the way out whatever happened inside.
 */
function withRebuildLock(stillNeeded, build) {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  let waiting = false;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    if (abandoned(LOCK_DIR)) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      continue;
    }
    if (!waiting) {
      waiting = true;
      console.error(dim("Waiting for another everyapp to finish rebuilding the CLI..."));
    }
    sleep(LOCK_POLL_MS);
  }
  try {
    fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid));
    const stale = stillNeeded();
    return stale ? build(stale) : true;
  } finally {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}

if (inCheckout && (pendingInstall() || staleness().cli)) {
  let installFailure = null;
  const built = withRebuildLock(
    // Checked again under the lock: the everyapp we waited for may have
    // installed and rebuilt.
    () => {
      const install = pendingInstall();
      return install || staleness().cli ? { install } : null;
    },
    ({ install }) => {
      if (install) {
        installFailure = installDependencies();
        if (installFailure) return false;
        stampInstall(install);
        console.error(dim("Installed this checkout's dependencies (pnpm-lock.yaml changed)"));
      }
      // Read after the install: its postinstall builds the SDK.
      const stale = staleness();
      if (!stale.cli) return true;
      // The CLI bundles the SDK from its dist/, and apps load it from there too.
      if (stale.sdk && !rebuild("pnpm", ["run", "build"], sdkDir)) return false;
      // tsup alone, no type check: `pnpm -C packages/cli build` type-checks.
      if (!rebuild("pnpm", ["exec", "tsup", "--silent"], cliDir)) return false;
      // The checkout's short commit. Not --dirty: that answers for every tracked
      // file in the repository (after `create` inside the checkout, the lockfile),
      // not for the sources this rebuild came from, and reads as a fault.
      const commit = spawnSync("git", ["describe", "--always", "--exclude=*"], {
        cwd: cliDir,
        encoding: "utf8",
      }).stdout.trim();
      console.error(dim(`Rebuilt the everyapp CLI from this checkout (${commit})`));
      return true;
    },
  );
  // Exited here, with the lock released: process.exit skips a finally.
  if (installFailure) {
    fail({
      code: "CHECKOUT_DEPENDENCIES_OUTDATED",
      message: `This checkout's dependencies are out of date, and installing them didn't work\npnpm-lock.yaml changed since the last install; \`pnpm install --frozen-lockfile\` in ${rootDir} ${installFailure}.`,
      rerun: INSTALL_COMMAND,
    });
  }
  if (!built) process.exit(1);
}

import("../dist/index.js").catch((error) => {
  if (error?.code === "ERR_MODULE_NOT_FOUND") {
    // In a checkout with dist/ built, what is missing is a package: the
    // dependencies are older than the code (the install is off, or CI).
    if (inCheckout && fs.existsSync(path.join(cliDir, "dist", "index.js"))) {
      fail({
        code: "CHECKOUT_DEPENDENCIES_OUTDATED",
        message: `This checkout's dependencies are out of date\n${String(error.message).split("\n")[0]}`,
        rerun: INSTALL_COMMAND,
      });
    }
    console.error(
      "everyapp CLI is not built. In the monorepo, run: pnpm -C packages/cli build",
    );
    process.exit(1);
  }
  throw error;
});
