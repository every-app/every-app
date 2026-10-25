#!/usr/bin/env node
/**
 * Point an app that lives in its own repository at this platform's CLI and
 * SDK, so a clone of that repository installs and builds with no Every App
 * checkout beside it: at the published packages, pinned to one exact
 * version (--npm <version>; `everyapp` and `@every-app/sdk` on npm under the
 * dist-tag `next` since 2026-10-25), or, when the published version
 * predates something the app needs, at the two packages packed from this
 * checkout and committed as file: tarballs under the app's vendor/.
 *
 *   pnpm pack-for-app <app dir> --npm <version> [--workflow] [--no-install]
 *   pnpm pack-for-app <app dir> [--workflow] [--no-build] [--no-install]
 *
 * With --npm: writes the exact version into package.json for both packages
 * (each in the dependency section it is in already), deletes vendor/'s
 * tarballs and README, then steps 5 and 6. Without it, in order:
 *
 *   1. builds the SDK and the CLI here (unless --no-build);
 *   2. packs both with `pnpm pack` into <app>/vendor/everyapp-<v>.tgz and
 *      <app>/vendor/every-app-sdk-<v>.tgz, replacing the ones there;
 *   3. points the app's package.json at them (`file:vendor/...`), keeping
 *      each in the dependency section it is in already;
 *   4. writes <app>/vendor/README.md: which commit of this repository the
 *      tarballs come from, how to refresh them, how to use a live checkout
 *      instead;
 *   5. with --workflow, installs scripts/pack-for-app/release.yml as the
 *      app's .github/workflows/release.yml (overwriting it): the GitHub
 *      Actions workflow that runs `everyapp release` and publishes
 *      everyapp-release.tar.gz on a GitHub release, the asset
 *      `pnpm everyapp install <repository url>` fetches;
 *   6. runs `pnpm install` in the app (unless --no-install), so its
 *      lockfile records the tarballs' integrity. A refreshed tarball under
 *      the same name changes that integrity: a `--frozen-lockfile` install
 *      against a stale lockfile fails loudly (ERR_PNPM_TARBALL_INTEGRITY),
 *      never silently builds with the old code.
 *
 * Commit vendor/, package.json and pnpm-lock.yaml in the app afterwards.
 * docs/runbooks/app-releases.md is the runbook.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKFLOW_TEMPLATE = path.join(ROOT, "scripts", "pack-for-app", "release.yml");
const PACKAGES = [
  { dir: "packages/cli", name: "everyapp", file: (v) => `everyapp-${v}.tgz`, section: "devDependencies" },
  { dir: "packages/sdk", name: "@every-app/sdk", file: (v) => `every-app-sdk-${v}.tgz`, section: "dependencies" },
];
const OURS = /^(everyapp|every-app-sdk)-.*\.tgz$/;

function usage(message) {
  if (message) console.error(`pack-for-app: ${message}`);
  console.error("usage: pnpm pack-for-app <app dir> [--npm <version>] [--workflow] [--no-build] [--no-install]");
  process.exit(message ? 1 : 0);
}

function run(command, args, cwd) {
  console.error(`$ ${[command, ...args].join(" ")}${cwd === ROOT ? "" : `  (in ${cwd})`}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** The indentation a JSON file uses (its first indented line's), so a rewrite changes only the lines it means to. */
function indentOf(file) {
  const match = /\n([ \t]+)"/.exec(fs.readFileSync(file, "utf8"));
  return match ? match[1] : 2;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) usage();
let npmVersion = null;
const npmAt = args.indexOf("--npm");
if (npmAt !== -1) {
  npmVersion = args[npmAt + 1];
  if (!npmVersion || npmVersion.startsWith("--") || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(npmVersion)) {
    usage("--npm takes an exact version, e.g. --npm 0.3.0-rc.1");
  }
  args.splice(npmAt, 2);
}
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
for (const flag of flags) {
  if (!["--workflow", "--no-build", "--no-install"].includes(flag)) usage(`unknown flag ${flag}`);
}
const targets = args.filter((arg) => !arg.startsWith("--"));
if (targets.length !== 1) usage("one app directory, please");
const app = path.resolve(targets[0]);
const appPackageJson = path.join(app, "package.json");
if (!fs.existsSync(appPackageJson)) usage(`${app} has no package.json`);
if (!fs.existsSync(path.join(app, "everyapp.config.ts"))) usage(`${app} has no everyapp.config.ts: not an Every App app`);

const vendor = path.join(app, "vendor");
const packed = [];
if (npmVersion) {
  // The published packages: nothing to build or pack; our tarballs go.
  if (fs.existsSync(vendor)) {
    for (const name of fs.readdirSync(vendor)) {
      if (OURS.test(name) || name === "README.md") fs.rmSync(path.join(vendor, name));
    }
    if (fs.readdirSync(vendor).length === 0) fs.rmSync(vendor, { recursive: true });
  }
  for (const pkg of PACKAGES) packed.push({ ...pkg, version: npmVersion, file: null, specifier: npmVersion });
} else {
  if (!flags.has("--no-build")) {
    run("pnpm", ["-C", "packages/sdk", "build"], ROOT);
    run("pnpm", ["-C", "packages/cli", "build"], ROOT);
  }
  fs.mkdirSync(vendor, { recursive: true });
  for (const name of fs.readdirSync(vendor)) {
    if (OURS.test(name)) fs.rmSync(path.join(vendor, name));
  }
  for (const pkg of PACKAGES) {
    const version = readJson(path.join(ROOT, pkg.dir, "package.json")).version;
    const file = pkg.file(version);
    run("pnpm", ["-C", pkg.dir, "pack", "--out", path.join(vendor, file)], ROOT);
    packed.push({ ...pkg, version, file, specifier: `file:vendor/${file}` });
  }
}

// package.json: each package in the section it is in already (its usual one when new).
const manifest = readJson(appPackageJson);
for (const pkg of packed) {
  const section =
    ["dependencies", "devDependencies"].find((key) => manifest[key]?.[pkg.name] !== undefined) ?? pkg.section;
  manifest[section] = { ...(manifest[section] ?? {}), [pkg.name]: pkg.specifier };
}
fs.writeFileSync(appPackageJson, `${JSON.stringify(manifest, null, indentOf(appPackageJson))}\n`);

const commit = git(["rev-parse", "--short", "HEAD"]);
const committed = git(["log", "-1", "--format=%cI"]).slice(0, 10);
const dirty = git(["status", "--porcelain", "--", "packages/cli", "packages/sdk", "packages/perimeter", "packages/toolbus"]) !== "";
const appName = path.basename(app);
if (!npmVersion) fs.writeFileSync(
  path.join(vendor, "README.md"),
  `# Vendored Every App packages

${packed.map((pkg) => `- \`${pkg.file}\`: ${pkg.name === "everyapp" ? "the Every App CLI" : "the Every App SDK"} ${pkg.version}`).join("\n")}

Both were packed with \`pnpm pack\` from the Every App repository
(https://github.com/every-app/every-app) at commit ${commit} (${committed})${dirty ? ", with uncommitted changes in its packages" : ""}.
\`package.json\` points at them (\`file:vendor/...\`), so a clone of this
repository installs and builds on its own, with no Every App checkout beside
it. The Release workflow (\`.github/workflows/release.yml\`) builds from them too.
They are the fallback for a published \`everyapp\` / \`@every-app/sdk\` that
predates something this app needs; \`pnpm pack-for-app ../${appName} --npm <version>\`
moves back to the published packages.
The CLI vendored here runs \`pnpm dev\`, \`pnpm everyapp db migrate\` and
\`pnpm everyapp release\`; deploying to a Gateway is done from an Every App
checkout (\`pnpm everyapp install <this repository's URL>\` there, or
\`pnpm everyapp deploy\` here with that checkout's CLI), because a deploy also
updates the Gateway from its source.

To refresh them, from an Every App checkout:

\`\`\`sh
pnpm pack-for-app ../${appName}
\`\`\`

It rebuilds the SDK and the CLI, packs both here, rewrites \`package.json\` and
runs \`pnpm install\`; commit \`vendor/\`, \`package.json\` and \`pnpm-lock.yaml\`.
To work against a live Every App checkout instead, point the two specifiers
at it (\`link:../every-app/packages/cli\`, \`link:../every-app/packages/sdk\`)
and don't commit that.
`,
);

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
    npmVersion ? `Pinned in ${app}:` : `Vendored into ${app}:`,
    ...packed.map((pkg) => `  ${pkg.name} ${pkg.version}  ->  ${pkg.specifier}`),
    npmVersion ? "  from npm (the dist-tag next; latest is older)" : `  from commit ${commit}${dirty ? " (packages dirty)" : ""}`,
    "",
    `Commit ${npmVersion ? "package.json and pnpm-lock.yaml (and vendor/'s removal)" : "vendor/, package.json and pnpm-lock.yaml"}${flags.has("--workflow") ? " and .github/workflows/release.yml" : ""} in the app.`,
  ].join("\n"),
);
