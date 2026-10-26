#!/usr/bin/env node
/**
 * Publish @every-app/sdk and everyapp to npm at one version, the way the
 * Gateway release and `everyapp create` expect them: same version for
 * both, built after the version is set, checked before anything goes out.
 *
 *   pnpm publish:rc 0.3.0-rc.7
 *
 * 1. Refuses unless the git tree is clean (what is published is HEAD).
 * 2. Sets the version in packages/sdk and packages/cli package.json and
 *    drops `"private": true` from both.
 * 3. Builds the SDK, then the CLI (which packs starter/ into the package).
 * 4. Runs the built CLI's `--version` and stops unless it says this version.
 * 5. Publishes the SDK, then the CLI, under the dist-tag `next`
 *    (npm asks for web authentication, once per package).
 * 6. Puts both package.json files back as git has them, whatever happened.
 * 7. Moves `latest` to this version for both, retrying while npm catches up.
 * 8. Prints the two commands that tag HEAD gateway-v<version> and push the
 *    tag to the `public` remote, which publishes the Gateway release the
 *    CLI downloads (.github/workflows/gateway-release.yml).
 *
 * Nothing is committed: the repository keeps its own version numbers, and
 * the CLI reads its version from its package.json at run time
 * (packages/cli/src/lib/version.ts), so the published one says what npm
 * says. See .github/RELEASE.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PACKAGES = [
  { dir: "packages/sdk", name: "@every-app/sdk" },
  { dir: "packages/cli", name: "everyapp" },
];

function fail(message) {
  console.error(`\npublish:rc: ${message}`);
  process.exit(1);
}

function run(command, args, cwd = ROOT) {
  console.log(`\n> ${[command, ...args].join(" ")}${cwd === ROOT ? "" : `   (in ${path.relative(ROOT, cwd)})`}`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail("usage: pnpm publish:rc <version>, e.g. pnpm publish:rc 0.3.0-rc.7");
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
if (git("status", "--porcelain") !== "") {
  fail("the git tree has changes; commit or stash them first, so what is published is HEAD.");
}
const head = git("rev-parse", "HEAD");
for (const { name } of PACKAGES) {
  const taken = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8" });
  if (taken.status === 0 && taken.stdout.trim() === version) {
    fail(`${name}@${version} is already on npm; pick the next version.`);
  }
}

const originals = new Map();
let published = false;
try {
  // 2. One version for both, nothing private.
  for (const { dir } of PACKAGES) {
    const file = path.join(ROOT, dir, "package.json");
    const text = fs.readFileSync(file, "utf8");
    originals.set(file, text);
    const pkg = JSON.parse(text);
    pkg.version = version;
    delete pkg.private;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // 3. Built after the version is set.
  run("pnpm", ["-C", "packages/sdk", "build"]);
  run("pnpm", ["-C", "packages/cli", "build"]);
  if (!fs.existsSync(path.join(ROOT, "packages/cli/starter/everyapp.config.ts"))) {
    throw new Error("the CLI build didn't pack starter/ into packages/cli/starter");
  }

  // 4. The built CLI says this version.
  const said = execFileSync(process.execPath, [path.join(ROOT, "packages/cli/bin/everyapp.js"), "--version"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (said !== `everyapp ${version}`) {
    throw new Error(`the built CLI says "${said}", not "everyapp ${version}"`);
  }
  console.log(`\nThe built CLI says: ${said}`);

  // 5. SDK first: the CLI's new apps depend on it.
  for (const { dir } of PACKAGES) {
    run("pnpm", ["publish", "--tag", "next", "--access", "public", "--no-git-checks"], path.join(ROOT, dir));
  }
  published = true;
} catch (error) {
  console.error(`\npublish:rc: ${error instanceof Error ? error.message : error}`);
} finally {
  // 6. The repository keeps its own versions.
  for (const [file, text] of originals) fs.writeFileSync(file, text);
}
if (!published) fail("nothing more was done; both package.json files are back as they were.");

// 7. latest, once npm knows the version (it can take a minute).
for (const { name } of PACKAGES) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync("npm", ["dist-tag", "add", `${name}@${version}`, "latest"], { stdio: "inherit" });
    if (result.status === 0) break;
    if (attempt === 10) fail(`couldn't move latest for ${name}; run: npm dist-tag add ${name}@${version} latest`);
    console.log(`npm doesn't have ${name}@${version} yet; trying again in 15 s (${attempt}/10)`);
    sleep(15_000);
  }
}

console.log(`
Published @every-app/sdk@${version} and everyapp@${version} (latest and next).

Now the Gateway release for this version. Push HEAD to the public repository
first if it isn't there yet, then tag it there:

  git tag gateway-v${version} ${head}
  git push public gateway-v${version}

The Gateway Release workflow publishes it in about three minutes:

  gh run watch -R every-app/every-app
`);
