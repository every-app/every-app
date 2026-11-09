#!/usr/bin/env node
/**
 * Releases the SDK, the CLI and the Gateway at one version. The version is
 * committed: the release is a commit that changes it, and publishing
 * publishes exactly what that commit says. Nothing is rewritten on the way
 * out and nothing has to be put back.
 *
 *   pnpm release <patch|minor|major|x.y.z>    1. bump: a "Release x.y.z" commit on a new branch
 *   pnpm release publish [--dry-run]          2. publish main's version to npm (after the merge)
 *
 * bump writes the version into packages/sdk, packages/cli and
 * apps/every-app-gateway package.json and the SDK's SDK_VERSION
 * (scripts/lib/versions.mjs), on a branch `release/<version>`, and commits.
 * Merge it like any pull request.
 *
 * publish, from a clean checkout of a commit that is on origin/main:
 *   1. checks the version is the same everywhere and not on npm yet;
 *   2. builds the SDK, then the CLI, and checks the built CLI says it;
 *   3. asks the built CLI whether it would install each public app's latest
 *      release (a warning only: the apps re-pin after the publish);
 *   4. publishes the SDK, then the CLI, under `latest` (npm asks for web
 *      authentication). A package already on npm at this version is skipped,
 *      so a publish that stopped half way is finished by running it again;
 *   5. says how to release the Gateway: the tag gateway-v<version> on the
 *      public repository, whose Gateway Release workflow publishes it.
 * --dry-run does 1–3 and says what it would publish.
 *
 * See .github/RELEASE.md and docs/design/2026-11-simplify-releases.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED, currentVersion, nextVersion, writeVersion } from "./lib/versions.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_REPO = "every-app/every-app";
const USAGE = "usage: pnpm release <patch|minor|major|x.y.z>   or   pnpm release publish [--dry-run]";

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

function bump(how) {
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
  console.log(`
${from} → ${version}, committed on ${branch}.

Merge it like any pull request:

  git push -u origin ${branch} && gh pr create --fill

Then, from main after the merge:

  git switch main && git pull && pnpm release publish
`);
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

/** What npm would publish from `dir` has its entry point and no local secrets file. */
function checkPackedFiles(dir, name) {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: path.join(ROOT, dir), encoding: "utf8" }),
  );
  const files = packed[0].files.map((file) => file.path);
  const secrets = files.filter((file) => /(^|\/)(\.dev\.vars|\.env)(\.|$)/.test(file) && !/\.example$/.test(file));
  if (secrets.length > 0) fail(`${name} would publish ${secrets.join(", ")}`);
  if (!files.some((file) => file.startsWith("dist/"))) fail(`${name} would publish no dist/: was it built?`);
  console.log(`${name}: ${files.length} files to publish, no .dev.vars or .env`);
}

/** Whether the public repository's main has HEAD (the Gateway tag must point at a public commit). */
function publicHasHead(head) {
  const fetched = spawnSync("git", ["fetch", "--quiet", `https://github.com/${PUBLIC_REPO}.git`, "main"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (fetched.status !== 0) return null;
  return spawnSync("git", ["merge-base", "--is-ancestor", head, "FETCH_HEAD"], { cwd: ROOT }).status === 0;
}

function publish({ dryRun }) {
  requireCleanTree();
  const version = current();
  const head = git("rev-parse", "HEAD");
  run("git", ["fetch", "--quiet", "origin", "main"]);
  if (spawnSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], { cwd: ROOT }).status !== 0) {
    fail(`HEAD (${head.slice(0, 9)}) isn't on origin/main. Publish from main, after the release commit is merged.`);
  }
  const pending = PUBLISHED.filter(({ name }) => !onNpm(name, version));
  console.log(
    pending.length === 0
      ? `\nBoth packages are on npm at ${version} already.`
      : `\nTo publish at ${version}: ${pending.map(({ name }) => name).join(", ")}`,
  );

  if (pending.length > 0) {
    run("pnpm", ["-C", "packages/sdk", "build"]);
    run("pnpm", ["-C", "packages/cli", "build"]);
    if (!fs.existsSync(path.join(ROOT, "packages/cli/starter/everyapp.config.ts"))) {
      fail("the CLI build didn't pack starter/ into packages/cli/starter");
    }
    const said = execFileSync(process.execPath, [path.join(ROOT, "packages/cli/bin/everyapp.js"), "--version"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    if (said !== `everyapp ${version}`) fail(`the built CLI says "${said}", not "everyapp ${version}"`);
    console.log(`\nThe built CLI says: ${said}`);
    for (const { dir, name } of pending) checkPackedFiles(dir, name);
  }

  const refused = checkPublicApps();

  for (const { dir, name } of pending) {
    if (dryRun) {
      console.log(`\n(dry run) would publish ${name}@${version} under latest from ${dir}`);
      continue;
    }
    // --tag latest is explicit: npm refuses a prerelease without a tag.
    run("pnpm", ["publish", "--tag", "latest", "--access", "public", "--no-git-checks"], path.join(ROOT, dir));
  }

  const tag = `gateway-v${version}`;
  const isPublic = publicHasHead(head);
  console.log(`
${dryRun ? "(dry run) " : ""}${pending.length > 0 && !dryRun ? `Published ${pending.map(({ name }) => `${name}@${version}`).join(" and ")}.\n\n` : ""}The Gateway release: tag ${head.slice(0, 9)} as ${tag} on the public repository.${
    isPublic === false
      ? `\nIt isn't on ${PUBLIC_REPO}'s main yet: let main reach it first (the mirror, or git push git@github.com:${PUBLIC_REPO}.git main:main).`
      : isPublic === null
        ? `\nCouldn't read ${PUBLIC_REPO}'s main; check the commit is there before tagging.`
        : ""
  }

  git push git@github.com:${PUBLIC_REPO}.git ${head}:refs/tags/${tag}
  gh run watch -R ${PUBLIC_REPO} $(gh run list -R ${PUBLIC_REPO} --workflow gateway-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
`);

  if (refused.length > 0) {
    console.log(`Warning: everyapp ${version} won't install these apps' latest releases:
${refused.map(({ repo, why }) => `\n  ${repo}\n    ${why}`).join("\n")}

Release each again: pin ${version} in the app (pnpm pack-for-app <app> --npm ${version}),
merge, and let its main reach the public repository, whose release workflow publishes it.
`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}
if (command === "publish") {
  const unknown = rest.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) fail(`unknown ${unknown.join(" ")}\n${USAGE}`);
  publish({ dryRun: rest.includes("--dry-run") });
} else {
  if (rest.length > 0) fail(USAGE);
  bump(command);
}
