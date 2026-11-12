// pnpm test:scripts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ShipRefusal, planLines, planShip, pushShip } from "./ship.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A private origin and a public repository (both bare, both throwaway), and
 * a checkout of the private one on main with one commit, which the public
 * one has too.
 */
function repositories() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-ship-"));
  dirs.push(base);
  const origin = path.join(base, "origin.git");
  const publicUrl = path.join(base, "public.git");
  const root = path.join(base, "checkout");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(base, "init", "-q", "--bare", "-b", "main", publicUrl);
  git(base, "init", "-q", "-b", "main", root);
  git(root, "remote", "add", "origin", origin);
  const commit = (message) => {
    fs.writeFileSync(path.join(root, "file.txt"), `${message}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "--no-gpg-sign", "-m", message);
    return git(root, "rev-parse", "HEAD");
  };
  const first = commit("Release 0.3.0");
  git(root, "push", "-q", "-u", "origin", "main");
  git(root, "push", "-q", publicUrl, "main:main");
  return { base, origin, publicUrl, root, commit, first, publicHead: () => git(publicUrl, "rev-parse", "main") };
}

describe("what ship would push", () => {
  it("is the commits the public main doesn't have, newest first, and pushes exactly them", () => {
    const repo = repositories();
    repo.commit("A fix");
    const head = repo.commit("Release 0.3.1");
    git(repo.root, "push", "-q", "origin", "main");

    const plan = planShip(repo);

    assert.equal(plan.head, head);
    assert.equal(plan.publicHead, repo.first);
    assert.deepEqual(
      plan.commits.map((line) => line.replace(/^\w+ /, "")),
      ["Release 0.3.1", "A fix"],
    );
    assert.deepEqual(planLines(plan), [
      `  Commits    2 (${repo.first.slice(0, 8)}..${head.slice(0, 8)})`,
      ...plan.commits.map((line) => `    ${line}`),
    ]);
    // Planning pushed nothing.
    assert.equal(repo.publicHead(), repo.first);

    pushShip({ ...repo, head });
    assert.equal(repo.publicHead(), head);
    assert.deepEqual(planShip(repo).commits, []);
  });

  it("shows the newest commits and counts the rest", () => {
    const lines = planLines({ head: "b".repeat(40), publicHead: "a".repeat(40), commits: ["3 c", "2 b", "1 a"] }, 2);
    assert.deepEqual(lines, ["  Commits    3 (aaaaaaaa..bbbbbbbb)", "    3 c", "    2 b", "    and 1 more"]);
  });

  it("refuses a tree with changes", () => {
    const repo = repositories();
    fs.writeFileSync(path.join(repo.root, "file.txt"), "edited\n");
    assert.throws(() => planShip(repo), (error) => error instanceof ShipRefusal && /has changes/.test(error.message));
  });

  it("refuses a branch that isn't main", () => {
    const repo = repositories();
    git(repo.root, "switch", "-q", "-c", "release/0.3.1");
    assert.throws(() => planShip(repo), (error) => error instanceof ShipRefusal && /is on release\/0\.3\.1, not main/.test(error.message));
  });

  it("refuses a main that isn't origin/main: commits not pushed, or not pulled", () => {
    const repo = repositories();
    repo.commit("Only here");
    assert.throws(() => planShip(repo), (error) => error instanceof ShipRefusal && /isn't what origin\/main is/.test(error.message));
  });

  it("refuses a push that wouldn't be a fast-forward, and pushes nothing", () => {
    const repo = repositories();
    // Something merged on the public repository itself.
    const other = path.join(repo.base, "other");
    git(repo.base, "clone", "-q", repo.publicUrl, other);
    fs.writeFileSync(path.join(other, "outside.txt"), "merged on public\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "--no-gpg-sign", "-m", "An outside pull request");
    git(other, "push", "-q", "origin", "main");
    const publicHead = repo.publicHead();
    repo.commit("Release 0.3.1");
    git(repo.root, "push", "-q", "origin", "main");

    assert.throws(() => planShip(repo), (error) => error instanceof ShipRefusal && /wouldn't be a fast-forward/.test(error.message));
    assert.equal(repo.publicHead(), publicHead);
  });

  it("says it couldn't read a public repository that isn't there", () => {
    const repo = repositories();
    assert.throws(
      () => planShip({ ...repo, publicUrl: path.join(repo.base, "nowhere.git") }),
      (error) => error instanceof ShipRefusal && /couldn't read the public repository's main/.test(error.message),
    );
  });
});

describe("pnpm release ship", () => {
  const SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "release.mjs");

  it("refuses without a terminal, before it reads or fetches anything", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "ship"], { encoding: "utf8", input: "y\n" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release: ship asks before it pushes, so it needs a terminal/);
    assert.match(result.stderr, /pnpm release ship --dry-run/);
    assert.equal(result.stdout, "");
  });

  it("no longer has publish", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "publish"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /publish is gone/);
  });
});
