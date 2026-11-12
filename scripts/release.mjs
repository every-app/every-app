#!/usr/bin/env node
/**
 * Releases the SDK, the CLI and the Gateway at one version. The version is
 * committed: the release is a commit that changes it, and publishing
 * publishes exactly what that commit says. Nothing is rewritten on the way
 * out and nothing has to be put back.
 *
 *   pnpm release <patch|minor|major|x.y.z>    1. bump: a "Release x.y.z" commit, pushed, its pull request opened
 *   pnpm release ship [--dry-run]             2. after the merge: push main to the public repository, which publishes
 *
 * bump writes the version into packages/sdk, packages/cli and
 * apps/every-app-gateway package.json and the SDK's SDK_VERSION
 * (scripts/lib/versions.mjs), on a branch `release/<version>`, commits,
 * pushes the branch and opens its pull request (--no-push stops after the
 * commit). Merge it like any pull request.
 *
 * ship is the release: the public repository's Release workflow
 * (.github/workflows/release.yml) publishes the Gateway release and both
 * npm packages when main arrives there with a version that isn't out yet.
 * From a clean main that is origin/main, it
 *   1. shows the version, what the push publishes, and the commits the
 *      public main doesn't have;
 *   2. checks the Leak Check is green on that commit, and that the push is
 *      a fast-forward;
 *   3. asks, and only on yes pushes main to the public repository;
 *   4. watches the Release workflow, and says how to run it again if it fails;
 *   5. asks the built CLI whether it would install each public app's latest
 *      release, and names the apps to re-pin.
 * It needs a terminal, because it asks. --dry-run does 1 and 2 and pushes
 * nothing.
 *
 * See .github/RELEASE.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { ShipRefusal, planLines, planShip, pushShip } from "./lib/ship.mjs";
import { PUBLISHED, currentVersion, nextVersion, writeVersion } from "./lib/versions.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_REPO = "every-app/every-app";
// Read anonymously over HTTPS (it is public); pushed over SSH, as it always was by hand.
const PUBLIC_READ_URL = `https://github.com/${PUBLIC_REPO}.git`;
const PUBLIC_PUSH_URL = `git@github.com:${PUBLIC_REPO}.git`;
const USAGE = "usage: pnpm release <patch|minor|major|x.y.z> [--no-push]   or   pnpm release ship [--dry-run]";

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

function run(command, args, cwd = ROOT) {
  console.log(`\n> ${[command, ...args].join(" ")}${cwd === ROOT ? "" : `   (in ${path.relative(ROOT, cwd)})`}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function requireCleanTree() {
  if (git("status", "--porcelain") !== "") {
    fail("the git tree has changes; commit or stash them first, so what is released is a commit.");
  }
}

/** Whether npm has `name` at `version`. */
function onNpm(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === version;
}

function current() {
  try {
    return currentVersion(ROOT);
  } catch (error) {
    fail(error.message);
  }
}

function bump(how, { push }) {
  requireCleanTree();
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    fail("bump from an up-to-date main: git switch main && git pull, then run this again.");
  }
  const from = current();
  let version;
  try {
    version = nextVersion(from, how);
  } catch (error) {
    fail(error.message);
  }
  for (const { name } of PUBLISHED) {
    if (onNpm(name, version)) fail(`${name}@${version} is already on npm; pick the next version.`);
  }
  const branch = `release/${version}`;
  git("switch", "-c", branch);
  writeVersion(ROOT, version);
  git("commit", "-am", `Release ${version}`);
  console.log(`\n${from} → ${version}, committed on ${branch}.`);
  const byHand = `git push -u origin ${branch} && gh pr create --fill`;
  if (!push) {
    console.log(`\nPush it and open its pull request:\n\n  ${byHand}\n`);
  } else {
    run("git", ["push", "-u", "origin", branch]);
    const opened = spawnSync(
      "gh",
      [
        "pr", "create", "--base", "main", "--head", branch,
        "--title", `Release ${version}`,
        "--body", `${from} → ${version} for @every-app/sdk, everyapp and the Gateway (\`pnpm release\`).\n\nMerging publishes nothing. After the merge, \`pnpm release ship\` pushes main to the public repository, whose Release workflow publishes.`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (opened.status === 0) console.log(`\nPull request: ${opened.stdout.trim()}`);
    else console.log(`\nThe branch is pushed, but the pull request wasn't opened (${(opened.stderr || "gh failed").trim()}). Open it:\n\n  gh pr create --fill`);
  }
  console.log(`\nMerge it, then release from main:\n\n  git switch main && git pull && pnpm release ship\n`);
}

/**
 * The public apps' repositories (landing-page/content/agent/apps.md's
 * table), each run through the built CLI's `install --dry-run`. Returns
 * the ones it refuses, with why.
 */
function checkPublicApps() {
  const table = fs.readFileSync(path.join(ROOT, "landing-page/content/agent/apps.md"), "utf8");
  const repos = [...table.matchAll(/\| (https:\/\/github\.com\/[\w.-]+\/[\w.-]+) \|/g)].map((m) => m[1]);
  if (repos.length === 0) fail("found no app repositories in landing-page/content/agent/apps.md");
  console.log("\nWould this everyapp install each public app's latest release?");
  const refused = [];
  for (const repo of repos) {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "packages/cli/bin/everyapp.js"), "install", repo, "--dry-run", "--json"],
      { cwd: ROOT, encoding: "utf8" },
    );
    let event = null;
    try {
      event = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } catch {}
    if (event?.type === "done") {
      console.log(`  ok       ${repo}`);
    } else {
      console.log(`  refused  ${repo}`);
      refused.push({ repo, why: event?.message ?? (result.stderr.trim() || `exit ${result.status}`) });
    }
  }
  return refused;
}

/** owner/name of the repository `origin` is, on github.com. */
function originRepo() {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"));
  if (!match) fail("origin isn't a github.com repository, so its Leak Check can't be read.");
  return match[1];
}

/** The Leak Check's conclusion on `sha` in the private repository: "success", another conclusion, "running", or "none". */
function leakCheck(sha) {
  const result = spawnSync(
    "gh",
    ["api", `repos/${originRepo()}/commits/${sha}/check-runs`, "--paginate", "--jq", ".check_runs[] | [.name, .status, (.conclusion // \"\")] | @tsv"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) fail(`couldn't read the checks on ${sha.slice(0, 8)} (gh: ${result.stderr.trim()})`);
  const runs = result.stdout.split("\n").map((line) => line.split("\t")).filter(([name]) => /^leak check/i.test(name ?? ""));
  if (runs.length === 0) return "none";
  if (runs.some(([, status]) => status !== "completed")) return "running";
  return runs.every(([, , conclusion]) => conclusion === "success") ? "success" : runs.find(([, , c]) => c !== "success")[2];
}

/** What a push at `version` makes the public Release workflow publish: the parts that aren't out yet. */
function unreleased(version) {
  const gateway = spawnSync("gh", ["release", "view", `gateway-v${version}`, "-R", PUBLIC_REPO], { encoding: "utf8" });
  return [
    ...(gateway.status === 0 ? [] : [`the Gateway release gateway-v${version}`]),
    ...PUBLISHED.filter(({ name }) => !onNpm(name, version)).map(({ name }) => `${name}@${version} on npm`),
  ];
}

/** The public Release workflow's run for `sha`, once it exists; null if none shows up in time. */
function releaseRun(sha) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync(
      "gh",
      ["run", "list", "-R", PUBLIC_REPO, "--workflow", "release.yml", "--commit", sha, "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId // empty"],
      { encoding: "utf8" },
    );
    const id = result.stdout.trim();
    if (result.status === 0 && id) return id;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  }
  return null;
}

async function ship({ dryRun }) {
  // Before anything is read: it asks before it pushes, and only a person answers.
  if (!dryRun && !(process.stdin.isTTY && process.stdout.isTTY)) {
    fail("ship asks before it pushes, so it needs a terminal. Run it yourself; to see what it would push: pnpm release ship --dry-run");
  }
  const version = current();
  let plan;
  try {
    plan = planShip({ root: ROOT, publicUrl: PUBLIC_READ_URL });
  } catch (error) {
    if (error instanceof ShipRefusal) fail(error.message);
    throw error;
  }
  const publishes = unreleased(version);
  console.log(
    [
      "",
      `Push main to ${PUBLIC_REPO}`,
      "",
      `  Version    ${version}`,
      `  Publishes  ${publishes.length > 0 ? publishes.join(", ") : `nothing: ${version} is released already`}`,
      ...planLines(plan),
    ].join("\n"),
  );
  if (plan.commits.length === 0) {
    console.log(`\nNothing to push.${publishes.length > 0 ? ` To publish what is missing, run the workflow again:\n\n  gh workflow run release.yml -R ${PUBLIC_REPO}` : ""}\n`);
    return;
  }
  const leak = leakCheck(plan.head);
  console.log(`  Leak Check ${leak === "success" ? "green" : leak} on ${plan.head.slice(0, 8)}`);
  if (leak !== "success") {
    fail(
      leak === "running"
        ? "the Leak Check on main hasn't finished. Run this again when it has."
        : leak === "none"
          ? `no Leak Check ran on ${plan.head.slice(0, 8)}, so nothing says these commits are safe to make public.`
          : `the Leak Check on main is ${leak}. Fix what it found before anything is pushed.`,
    );
  }
  if (dryRun) {
    console.log("\n(dry run) Nothing pushed.\n");
    return;
  }

  const ask = readline.createInterface({ input: process.stdin, output: process.stdout });
  const what = `${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}`;
  const answer = await ask.question(
    `\nPush ${what} to ${PUBLIC_REPO}${publishes.length > 0 ? ` and publish ${version}` : " (publishes nothing)"}? This can't be undone. [y/N] `,
  );
  ask.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("\nNothing pushed.\n");
    return;
  }
  pushShip({ root: ROOT, publicUrl: PUBLIC_PUSH_URL, head: plan.head });
  console.log(`\nPushed ${plan.head.slice(0, 8)} to ${PUBLIC_REPO}.`);

  const again = `gh workflow run release.yml -R ${PUBLIC_REPO}`;
  if (publishes.length > 0) {
    console.log("\nWaiting for the Release workflow...");
    const id = releaseRun(plan.head);
    if (!id) {
      fail(`the Release workflow hasn't started for ${plan.head.slice(0, 8)}. Look, or start it:\n\n  gh run list -R ${PUBLIC_REPO} --workflow release.yml --limit 3\n  ${again}`);
    }
    const watched = spawnSync("gh", ["run", "watch", id, "-R", PUBLIC_REPO, "--exit-status"], { stdio: "inherit" });
    if (watched.status !== 0) {
      fail(`the Release workflow failed. Each step skips what is out already, so run it again once it is fixed:\n\n  ${again}`);
    }
    console.log(`\nReleased ${version}: the Gateway release and both npm packages are out.`);
  }

  const refused = checkPublicApps();
  console.log(`
Re-pin each app to ${version} (or merge its Dependabot pull request):

  pnpm pack-for-app <app directory> --npm ${version}
`);
  if (refused.length > 0) {
    console.log(`Warning: everyapp ${version} won't install these apps' latest releases until they are re-pinned and released again:
${refused.map(({ repo, why }) => `\n  ${repo}\n    ${why}`).join("\n")}
`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
if (command === "ship") {
  const unknown = rest.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) fail(`unknown ${unknown.join(" ")}\n${USAGE}`);
  await ship({ dryRun: rest.includes("--dry-run") });
} else if (command === "publish") {
  fail(`publish is gone: the public repository's Release workflow publishes. pnpm release ship pushes main there; gh workflow run release.yml -R ${PUBLIC_REPO} finishes a run that failed.`);
} else {
  const unknown = rest.filter((arg) => arg !== "--no-push");
  if (unknown.length > 0) fail(USAGE);
  bump(command, { push: !rest.includes("--no-push") });
}
