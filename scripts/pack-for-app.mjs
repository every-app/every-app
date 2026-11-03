#!/usr/bin/env node
/**
 * Pin an app that lives in its own repository to the published EveryApp CLI
 * and SDK on npm, so a clone installs and builds with no Every App checkout
 * beside it:
 *
 *   pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]
 *
 * --npm takes one exact version or a caret range (`^0.3.0-rc.10`, what
 * `everyapp create` writes).
 *
 * Apps never carry the SDK or CLI as tarballs (no vendor/, no `file:`
 * specifiers). Unreleased platform code is tried locally with `pnpm link`
 * (docs/runbooks/app-releases.md) and shipped by publishing an rc.
 *
 * In order:
 *
 *   1. writes the version into the app's package.json for both packages,
 *      each in the dependency section it is in already;
 *   2. deletes tarballs and vendor/README.md that the retired vendoring
 *      left (and vendor/ when that empties it), and the `!vendor/*.tgz`
 *      .gitignore line;
 *   3. with --workflow, installs starter/.github/workflows/release.yml as the
 *      app's .github/workflows/release.yml (overwriting it): the GitHub
 *      Actions workflow whose one step, `everyapp release --publish`,
 *      packs the app and publishes everyapp-release.tar.gz on a GitHub
 *      release, the asset `everyapp install <repository url>` fetches;
 *   4. runs `pnpm install` in the app (unless --no-install), so its
 *      lockfile records the pin.
 *
 * Commit package.json and pnpm-lock.yaml (and vendor/'s removal, .gitignore
 * and the workflow when they changed) in the app afterwards.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** The one template: what `everyapp create` gives a new app, too. */
const WORKFLOW_TEMPLATE = path.join(ROOT, "starter", ".github", "workflows", "release.yml");
const PACKAGES = [
  { name: "everyapp", section: "devDependencies" },
  { name: "@every-app/sdk", section: "dependencies" },
];
/** What the retired vendoring left in an app. */
const VENDORED = /^(everyapp|every-app-sdk)-.*\.tgz$/;
const UNIGNORE = "!vendor/*.tgz";
const USAGE = "usage: pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]";

function usage(message) {
  if (message) console.error(`pack-for-app: ${message}`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

function run(command, args, cwd) {
  console.error(`$ ${[command, ...args].join(" ")}  (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The indentation a JSON file uses (its first indented line's), so a rewrite changes only the lines it means to. */
function indentOf(file) {
  const match = /\n([ \t]+)"/.exec(fs.readFileSync(file, "utf8"));
  return match ? match[1] : 2;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();
if (args.includes("--vendor")) {
  usage("--vendor is gone: apps never carry the SDK or CLI as tarballs. Try unreleased code with `pnpm link` (docs/runbooks/app-releases.md), then publish an rc and pin it with --npm.");
}
const npmAt = args.indexOf("--npm");
if (npmAt === -1) usage("--npm <version>, please");
const version = args[npmAt + 1];
if (!version || version.startsWith("--") || !/^\^?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  usage("--npm takes an exact version or a caret range, e.g. --npm 0.3.0-rc.10 or --npm ^0.3.0-rc.10");
}
args.splice(npmAt, 2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
for (const flag of flags) {
  if (!["--workflow", "--no-install"].includes(flag)) usage(`unknown flag ${flag}`);
}
const targets = args.filter((arg) => !arg.startsWith("--"));
if (targets.length !== 1) usage("one app directory, please");
const app = path.resolve(targets[0]);
const appPackageJson = path.join(app, "package.json");
if (!fs.existsSync(appPackageJson)) usage(`${app} has no package.json`);
if (!fs.existsSync(path.join(app, "everyapp.config.ts"))) usage(`${app} has no everyapp.config.ts: not an EveryApp app`);

// 1. package.json: each package in the section it is in already (its usual one when new).
const manifest = readJson(appPackageJson);
for (const pkg of PACKAGES) {
  const section =
    ["dependencies", "devDependencies"].find((key) => manifest[key]?.[pkg.name] !== undefined) ?? pkg.section;
  manifest[section] = { ...(manifest[section] ?? {}), [pkg.name]: version };
}
fs.writeFileSync(appPackageJson, `${JSON.stringify(manifest, null, indentOf(appPackageJson))}\n`);

// 2. What the retired vendoring left.
const vendor = path.join(app, "vendor");
let removedVendor = false;
if (fs.existsSync(vendor)) {
  for (const name of fs.readdirSync(vendor)) {
    if (VENDORED.test(name) || name === "README.md") {
      fs.rmSync(path.join(vendor, name));
      removedVendor = true;
    }
  }
  if (fs.readdirSync(vendor).length === 0) fs.rmSync(vendor, { recursive: true });
}
const gitignore = path.join(app, ".gitignore");
let gitignoreChanged = false;
if (fs.existsSync(gitignore)) {
  const lines = fs.readFileSync(gitignore, "utf8").split("\n");
  if (lines.includes(UNIGNORE)) {
    fs.writeFileSync(gitignore, lines.filter((line) => line !== UNIGNORE).join("\n"));
    gitignoreChanged = true;
  }
}

// 3.
if (flags.has("--workflow")) {
  const workflowsDir = path.join(app, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.copyFileSync(WORKFLOW_TEMPLATE, path.join(workflowsDir, "release.yml"));
  console.error(`wrote ${path.relative(app, path.join(workflowsDir, "release.yml"))}`);
}

// 4.
if (!flags.has("--no-install")) run("pnpm", ["install"], app);

const commitList = [
  "package.json",
  "pnpm-lock.yaml",
  ...(removedVendor ? ["vendor/'s removal"] : []),
  ...(gitignoreChanged ? [".gitignore"] : []),
  ...(flags.has("--workflow") ? [".github/workflows/release.yml"] : []),
];
console.error(
  [
    "",
    `Pinned in ${app}:`,
    ...PACKAGES.map((pkg) => `  ${pkg.name}  ->  ${version}  (npm)`),
    "",
    `Commit ${commitList.join(", ")} in the app.`,
  ].join("\n"),
);
