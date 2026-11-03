#!/usr/bin/env node
/**
 * Point an app that lives in its own repository at this platform's CLI and
 * SDK, so a clone of that repository installs and builds with no Every App
 * checkout beside it. Two ways:
 *
 *   pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]
 *   pnpm pack-for-app <app dir> --vendor [--workflow] [--no-install]
 *
 * --npm <version> pins the published packages (`everyapp` and
 * `@every-app/sdk` on npm) at one exact version, or a caret range
 * (`^0.3.0-rc.10`, what `everyapp create` writes). It is also the way back
 * from --vendor: it deletes what --vendor wrote.
 *
 * --vendor packs this checkout's HEAD instead, for code no release carries
 * yet (dogfooding a branch): `git archive HEAD` into a temporary directory,
 * a filtered `pnpm install`, the SDK and CLI builds, `pnpm pack`, and the
 * two tarballs into the app's vendor/ as
 * `<package>-<version>-<commit>.tgz`, named in package.json as
 * `file:vendor/…`, with vendor/README.md saying which commit and how to go
 * back. Uncommitted changes are not packed (HEAD only; it warns).
 *
 * In order:
 *
 *   1. --vendor: packs the tarballs (above);
 *   2. writes the version (or the `file:` specifier) into the app's
 *      package.json for both packages, each in the dependency section it is
 *      in already;
 *   3. deletes vendored tarballs and vendor/README.md an earlier --vendor
 *      left (all of them for --npm, and vendor/ when that empties it; the
 *      older commit's for --vendor), and keeps the app's .gitignore from
 *      hiding the new tarballs (--vendor adds `!vendor/*.tgz` when it would;
 *      --npm takes that line out again);
 *   4. with --workflow, installs starter/.github/workflows/release.yml as the
 *      app's .github/workflows/release.yml (overwriting it): the GitHub
 *      Actions workflow whose one step, `everyapp release --publish`,
 *      packs the app and publishes everyapp-release.tar.gz on a GitHub
 *      release, the asset `everyapp install <repository url>` fetches
 *      (the pinned everyapp must have --publish: newer than 0.3.0-rc.3);
 *   5. runs `pnpm install` in the app (unless --no-install), so its
 *      lockfile records the pin.
 *
 * Commit package.json and pnpm-lock.yaml (and vendor/, .gitignore and the
 * workflow when they changed) in the app afterwards.
 * docs/runbooks/app-releases.md is the runbook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** The one template: what `everyapp create` gives a new app, too. */
const WORKFLOW_TEMPLATE = path.join(ROOT, "starter", ".github", "workflows", "release.yml");
const PACKAGES = [
  { name: "everyapp", section: "devDependencies", dir: "packages/cli", file: "everyapp" },
  { name: "@every-app/sdk", section: "dependencies", dir: "packages/sdk", file: "every-app-sdk" },
];
/** What --vendor (and the vendoring this script did before 2026-10-26) leaves in an app. */
const VENDORED = /^(everyapp|every-app-sdk)-.*\.tgz$/;
/** The .gitignore line --vendor adds when the app ignores the tarballs. */
const UNIGNORE = "!vendor/*.tgz";
const USAGE = "usage: pnpm pack-for-app <app dir> (--npm <version> | --vendor) [--workflow] [--no-install]";

function usage(message) {
  if (message) console.error(`pack-for-app: ${message}`);
  console.error(USAGE);
  process.exit(message ? 1 : 0);
}

function run(command, args, cwd) {
  console.error(`$ ${[command, ...args].join(" ")}  (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The indentation a JSON file uses (its first indented line's), so a rewrite changes only the lines it means to. */
function indentOf(file) {
  const match = /\n([ \t]+)"/.exec(fs.readFileSync(file, "utf8"));
  return match ? match[1] : 2;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();
const npmAt = args.indexOf("--npm");
const vendorMode = args.includes("--vendor");
if (npmAt === -1 && !vendorMode) usage("--npm <version> or --vendor, please");
if (npmAt !== -1 && vendorMode) usage("--npm or --vendor, not both");
let version = null;
if (npmAt !== -1) {
  version = args[npmAt + 1];
  if (!version || version.startsWith("--") || !/^\^?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    usage("--npm takes an exact version or a caret range, e.g. --npm 0.3.0-rc.10 or --npm ^0.3.0-rc.10");
  }
  args.splice(npmAt, 2);
}
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
for (const flag of flags) {
  if (!["--vendor", "--workflow", "--no-install"].includes(flag)) usage(`unknown flag ${flag}`);
}
const targets = args.filter((arg) => !arg.startsWith("--"));
if (targets.length !== 1) usage("one app directory, please");
const app = path.resolve(targets[0]);
const appPackageJson = path.join(app, "package.json");
if (!fs.existsSync(appPackageJson)) usage(`${app} has no package.json`);
if (!fs.existsSync(path.join(app, "everyapp.config.ts"))) usage(`${app} has no everyapp.config.ts: not an EveryApp app`);
const vendor = path.join(app, "vendor");

/**
 * HEAD of this checkout, built and packed in a temporary directory (the
 * checkout's own node_modules and dist/ are never used). Returns each
 * package's tarball path there, by package name.
 */
function packCheckout(commit) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-vendor-"));
  const src = path.join(work, "src");
  const out = path.join(work, "out");
  fs.mkdirSync(src);
  fs.mkdirSync(out);
  const archive = path.join(work, "head.tar");
  run("git", ["archive", "--format=tar", "-o", archive, commit], ROOT);
  run("tar", ["-xf", archive, "-C", src], work);
  run(
    "pnpm",
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      ...PACKAGES.flatMap((pkg) => ["--filter", `${pkg.name}...`]),
    ],
    src,
  );
  // The SDK first: the CLI bundles it.
  for (const pkg of [...PACKAGES].reverse()) run("pnpm", ["run", "build"], path.join(src, pkg.dir));
  const tarballs = {};
  for (const pkg of PACKAGES) {
    const before = new Set(fs.readdirSync(out));
    run("pnpm", ["pack", "--pack-destination", out], path.join(src, pkg.dir));
    const made = fs.readdirSync(out).filter((name) => !before.has(name) && name.endsWith(".tgz"));
    if (made.length !== 1) throw new Error(`pnpm pack in ${pkg.dir} made ${made.length} tarballs`);
    tarballs[pkg.name] = {
      path: path.join(out, made[0]),
      version: readJson(path.join(src, pkg.dir, "package.json")).version,
    };
  }
  return { work, tarballs };
}

// 1. --vendor: the tarballs.
let packed = null;
let commit = null;
if (vendorMode) {
  commit = git("rev-parse", "--short=8", "HEAD");
  const dirty = git("status", "--porcelain");
  if (dirty) console.error(`pack-for-app: uncommitted changes in ${ROOT} are not packed (HEAD ${commit} only)`);
  packed = packCheckout(commit);
}

// 3 (first, so a re-vendor replaces the old tarballs): what an earlier --vendor left.
let removedVendor = false;
if (fs.existsSync(vendor)) {
  for (const name of fs.readdirSync(vendor)) {
    if (VENDORED.test(name) || name === "README.md") {
      fs.rmSync(path.join(vendor, name));
      removedVendor = true;
    }
  }
  if (!vendorMode && fs.readdirSync(vendor).length === 0) fs.rmSync(vendor, { recursive: true });
}

const specifiers = {};
if (vendorMode) {
  fs.mkdirSync(vendor, { recursive: true });
  for (const pkg of PACKAGES) {
    const { path: from, version: packageVersion } = packed.tarballs[pkg.name];
    const name = `${pkg.file}-${packageVersion}-${commit}.tgz`;
    fs.copyFileSync(from, path.join(vendor, name));
    specifiers[pkg.name] = `file:vendor/${name}`;
  }
  fs.rmSync(packed.work, { recursive: true, force: true });
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const full = git("rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(vendor, "README.md"),
    [
      "# vendor/: an unreleased EveryApp SDK and CLI",
      "",
      `Packed by \`pnpm pack-for-app <this app> --vendor\` from an EveryApp checkout`,
      `at ${full} (branch \`${branch}\`) on ${new Date().toISOString().slice(0, 10)}:`,
      "",
      ...PACKAGES.map((pkg) => `- \`${pkg.name}\`: \`${specifiers[pkg.name]}\``),
      "",
      "To take a newer commit, run the same command again from the checkout.",
      "Once a release carries what this app needs, go back to npm:",
      "",
      "```sh",
      "pnpm pack-for-app <this app> --npm <version>",
      "```",
      "",
      "which pins both packages to that version and deletes this folder.",
      "",
    ].join("\n"),
  );
} else {
  for (const pkg of PACKAGES) specifiers[pkg.name] = version;
}

// 2. package.json: each package in the section it is in already (its usual one when new).
const manifest = readJson(appPackageJson);
for (const pkg of PACKAGES) {
  const section =
    ["dependencies", "devDependencies"].find((key) => manifest[key]?.[pkg.name] !== undefined) ?? pkg.section;
  manifest[section] = { ...(manifest[section] ?? {}), [pkg.name]: specifiers[pkg.name] };
}
fs.writeFileSync(appPackageJson, `${JSON.stringify(manifest, null, indentOf(appPackageJson))}\n`);

// 3. .gitignore: the tarballs are committed, so a clone installs.
const gitignore = path.join(app, ".gitignore");
let gitignoreChanged = false;
const ignoreLines = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, "utf8").split("\n") : null;
if (vendorMode) {
  const probe = specifiers.everyapp.slice("file:".length);
  let ignored = false;
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", probe], { cwd: app, stdio: "ignore" });
    ignored = true;
  } catch {
    // exit 1: not ignored; not a git repository: nothing to keep.
  }
  if (ignored && !(ignoreLines ?? []).includes(UNIGNORE)) {
    const text = ignoreLines ? ignoreLines.join("\n") : "";
    fs.writeFileSync(gitignore, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${UNIGNORE}\n`);
    gitignoreChanged = true;
  }
} else if (ignoreLines?.includes(UNIGNORE)) {
  fs.writeFileSync(gitignore, ignoreLines.filter((line) => line !== UNIGNORE).join("\n"));
  gitignoreChanged = true;
}

// 4.
if (flags.has("--workflow")) {
  const workflowsDir = path.join(app, ".github", "workflows");
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.copyFileSync(WORKFLOW_TEMPLATE, path.join(workflowsDir, "release.yml"));
  console.error(`wrote ${path.relative(app, path.join(workflowsDir, "release.yml"))}`);
}

// 5.
if (!flags.has("--no-install")) run("pnpm", ["install"], app);

const commitList = [
  "package.json",
  "pnpm-lock.yaml",
  ...(vendorMode ? ["vendor/"] : removedVendor ? ["vendor/'s removal"] : []),
  ...(gitignoreChanged ? [".gitignore"] : []),
  ...(flags.has("--workflow") ? [".github/workflows/release.yml"] : []),
];
console.error(
  [
    "",
    `${vendorMode ? "Vendored" : "Pinned"} in ${app}:`,
    ...PACKAGES.map((pkg) => `  ${pkg.name}  ->  ${specifiers[pkg.name]}`),
    vendorMode
      ? `  packed from this checkout's HEAD ${commit}; back to npm: pnpm pack-for-app ${targets[0]} --npm <version>`
      : "  from npm",
    "",
    `Commit ${commitList.join(", ")} in the app.`,
  ].join("\n"),
);
