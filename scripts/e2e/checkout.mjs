/**
 * The checkout an upgrade starts from: a git worktree of a ref (a branch, a
 * tag, a commit) with its own dependencies, in ~/.cache/everyapp/e2e-base.
 * Kept by commit between runs, so the next upgrade from the same base
 * installs nothing new. `git worktree remove <dir>` deletes one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE_DIR = path.join(os.homedir(), ".cache", "everyapp", "e2e-base");

/** The repository root `dir` is in. */
export function repoRoot(dir) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
}

/** A worktree of `ref`, fetched first, with its dependencies installed: its directory. */
export function baseCheckout({ repo, ref }) {
  execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: repo, stdio: "inherit" });
  const sha = execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const dir = path.join(BASE_DIR, sha.slice(0, 12));
  if (!fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["worktree", "add", "--detach", dir, sha], { cwd: repo, stdio: "inherit" });
  }
  execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: dir, stdio: "inherit" });
  return dir;
}
