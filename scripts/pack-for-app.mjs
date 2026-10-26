#!/usr/bin/env node
/**
 * Point an app that lives in its own repository at this platform's
 * published CLI and SDK, pinned to one exact version (`everyapp` and
 * `@every-app/sdk` on npm, dist-tag `next`), so a clone of that repository
 * installs and builds with no Every App checkout beside it.
 *
 *   pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]
 *
 * In order:
 *
 *   1. writes the exact version into the app's package.json for both
 *      packages, each in the dependency section it is in already;
 *   2. deletes the vendored tarballs (vendor/everyapp-*.tgz,
 *      vendor/every-app-sdk-*.tgz) and vendor/README.md an older version of
 *      this script left, and vendor/ when that empties it;
 *   3. with --workflow, installs scripts/pack-for-app/release.yml as the
 *      app's .github/workflows/release.yml (overwriting it): the GitHub
 *      Actions workflow whose one step, `everyapp release --publish`,
 *      packs the app and publishes everyapp-release.tar.gz on a GitHub
 *      release, the asset `everyapp install <repository url>` fetches
 *      (the pinned everyapp must have --publish: newer than 0.3.0-rc.3);
 *   4. runs `pnpm install` in the app (unless --no-install), so its
 *      lockfile records the pin.
 *
 * Commit package.json and pnpm-lock.yaml (and vendor/'s removal, and the
 * workflow) in the app afterwards. docs/runbooks/app-releases.md is the
 * runbook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_TEMPLATE = path.join(ROOT, "scripts", "pack-for-app", "release.yml");
const PACKAGES = [
  { name: "everyapp", section: "devDependencies" },
  { name: "@every-app/sdk", section: "dependencies" },
];
/** What the vendoring this script used to do left in an app. */
const VENDORED = /^(everyapp|every-app-sdk)-.*\.tgz$/;

function usage(message) {
  if (message) console.error(`pack-for-app: ${message}`);
  console.error("usage: pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]");
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
const npmAt = args.indexOf("--npm");
if (npmAt === -1) usage("--npm <version> is required, e.g. --npm 0.3.0-rc.3 (vendored tarballs are gone)");
const version = args[npmAt + 1];
if (!version || version.startsWith("--") || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  usage("--npm takes an exact version, e.g. --npm 0.3.0-rc.3");
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

// package.json: each package in the section it is in already (its usual one when new).
const manifest = readJson(appPackageJson);
for (const pkg of PACKAGES) {
  const section =
    ["dependencies", "devDependencies"].find((key) => manifest[key]?.[pkg.name] !== undefined) ?? pkg.section;
  manifest[section] = { ...(manifest[section] ?? {}), [pkg.name]: version };
}
fs.writeFileSync(appPackageJson, `${JSON.stringify(manifest, null, indentOf(appPackageJson))}\n`);

// The tarballs an older pack-for-app vendored: gone, with their README.
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

if (flags.has("--workflow")) {
  const workflowsDir = path.join(app, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.copyFileSync(WORKFLOW_TEMPLATE, path.join(workflowsDir, "release.yml"));
  console.error(`wrote ${path.relative(app, path.join(workflowsDir, "release.yml"))}`);
}

if (!flags.has("--no-install")) run("pnpm", ["install"], app);

console.error(
  [
    "",
    `Pinned in ${app}:`,
    ...PACKAGES.map((pkg) => `  ${pkg.name}  ->  ${version}`),
    "  from npm (the dist-tag next; latest is older)",
    "",
    `Commit package.json and pnpm-lock.yaml${removedVendor ? " (and vendor/'s removal)" : ""}${flags.has("--workflow") ? " and .github/workflows/release.yml" : ""} in the app.`,
  ].join("\n"),
);
