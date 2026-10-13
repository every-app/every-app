/**
 * Build the gateway release the everyapp CLI ships and deploys.
 *
 *   node scripts/build-release.ts [--skip-build] [--out <tarball>]
 *
 * `cf build` (production) writes the Build Output; this stages only what a
 * deploy needs, with nothing to install:
 *
 *   .cloudflare/output/v0/…   the prebuilt Worker and its assets
 *   drizzle/*.sql             migrations, applied with `cf d1 migrations apply`
 *   release.json              version, toolchain, sha256, migration journal
 *
 * and refuses to ship local state (.cloudflare/state, .dev.vars, keys) or a
 * Build Output that already carries what the deploy patches in per install
 * (resource ids, app bindings, domains). `everyapp gateway deploy` checks
 * the sha256 before it patches and uploads the release.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_OUTPUT_DIR = ".cloudflare/output";
const TARBALL_NAME = "every-app-gateway-release.tar.gz";
const PATCH_PLACEHOLDER = "__EVERYAPP_PATCH__";
/** The oldest everyapp CLI and SDK that can deploy and talk to this release. */
const MIN_CLI_VERSION = "0.3.0";
const MIN_SDK_VERSION = "0.3.0";

export interface ReleaseManifest {
  schema: 1;
  version: string;
  gitSha: string;
  builtAt: string;
  cfVersion: string;
  pluginVersion: string;
  configVersion: string;
  buildOutputVersion: string;
  /** Of every staged file but release.json (see {@link hashTree}). */
  sha256: string;
  /** drizzle's journal, so a deploy can tell which migrations ran. */
  migrations: Array<{ tag: string; when: number }>;
  minCli: string;
  minSdk: string;
}

export interface StageReleaseOptions {
  gatewayDir: string;
  stageDir: string;
  /** Everything release.json records besides what staging computes. */
  build: Omit<
    ReleaseManifest,
    "schema" | "sha256" | "migrations" | "buildOutputVersion"
  >;
}

export class ReleaseBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseBuildError";
  }
}

/** Copy the Build Output and migrations into `stageDir` and write release.json. */
export function stageRelease({
  gatewayDir,
  stageDir,
  build,
}: StageReleaseOptions): ReleaseManifest {
  const outputRoot = path.join(gatewayDir, BUILD_OUTPUT_DIR);
  const versions = fs.existsSync(outputRoot) ? fs.readdirSync(outputRoot) : [];
  if (versions.length !== 1) {
    throw new ReleaseBuildError(
      `Expected one Build Output version in ${outputRoot}, found ${versions.length ? versions.join(", ") : "none"}. Run \`cf build\` first.`,
    );
  }
  const buildOutputVersion = versions[0]!;
  const outputDir = path.join(outputRoot, buildOutputVersion);
  checkBuildOutput(outputDir);

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  fs.cpSync(
    outputDir,
    path.join(stageDir, BUILD_OUTPUT_DIR, buildOutputVersion),
    { recursive: true, dereference: true },
  );
  const migrationsDir = path.join(stageDir, "drizzle");
  fs.mkdirSync(migrationsDir);
  for (const file of fs.readdirSync(path.join(gatewayDir, "drizzle"))) {
    if (file.endsWith(".sql")) {
      fs.copyFileSync(
        path.join(gatewayDir, "drizzle", file),
        path.join(migrationsDir, file),
      );
    }
  }
  checkStagedFiles(stageDir);

  const manifest: ReleaseManifest = {
    schema: 1,
    ...build,
    buildOutputVersion,
    sha256: hashTree(stageDir),
    migrations: readJournal(gatewayDir),
  };
  fs.writeFileSync(
    path.join(stageDir, "release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/**
 * SHA-256 over every file under `root` except release.json: each file's
 * relative path and the SHA-256 of its contents, in path order. The CLI
 * computes the same over an extracted release.
 */
export function hashTree(root: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    if (file === "release.json") continue;
    const content = createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex");
    hash.update(`${file}\0${content}\n`);
  }
  return hash.digest("hex");
}

function listFiles(root: string, dir = ""): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, dir), {
    withFileTypes: true,
  })) {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else files.push(relative);
  }
  return files.sort();
}

/** The production gateway Build Output, untouched by any install. */
function checkBuildOutput(outputDir: string): void {
  const rootConfig = JSON.parse(
    fs.readFileSync(path.join(outputDir, "config.json"), "utf8"),
  ) as { buildContext?: { mode?: string; isPreview?: boolean } };
  if (
    rootConfig.buildContext?.mode !== "production" ||
    rootConfig.buildContext.isPreview
  ) {
    throw new ReleaseBuildError(
      "The Build Output isn't a production build. Run `cf build` without --mode.",
    );
  }

  const workerConfig = JSON.parse(
    fs.readFileSync(
      path.join(outputDir, "workers", "default", "worker.config.json"),
      "utf8",
    ),
  ) as {
    name?: string;
    domains?: unknown[];
    triggers?: unknown[];
    env?: Record<string, { type?: string; id?: string; value?: unknown }>;
  };
  const problems: string[] = [];
  if (workerConfig.name !== "every-app-gateway") {
    problems.push(`its Worker is "${workerConfig.name}"`);
  }
  if (workerConfig.domains?.length) problems.push("it declares domains");
  if (workerConfig.triggers?.length) problems.push("it declares triggers");
  for (const [name, binding] of Object.entries(workerConfig.env ?? {})) {
    if (name.startsWith("APP__")) problems.push(`it binds ${name}`);
    if ((binding.type === "kv" || binding.type === "d1") && binding.id) {
      problems.push(`${name} has a resource id`);
    }
  }
  if (!JSON.stringify(workerConfig.env ?? {}).includes(PATCH_PLACEHOLDER)) {
    problems.push("EVERYAPP_RELEASE has no deploy placeholder");
  }
  if (problems.length > 0) {
    throw new ReleaseBuildError(
      `The Build Output isn't a clean gateway release: ${problems.join("; ")}. Build it from cloudflare.config.ts in production mode.`,
    );
  }
}

/** Nothing local or secret may ship. */
function checkStagedFiles(stageDir: string): void {
  const forbidden = listFiles(stageDir).filter((file) => {
    const base = path.posix.basename(file);
    return (
      base.startsWith(".dev.vars") ||
      base.startsWith(".env") ||
      base.endsWith(".pem") ||
      /(^|\/)\.cloudflare\/(state|types)(\/|$)/.test(file) ||
      /(^|\/)\.wrangler(\/|$)/.test(file)
    );
  });
  if (forbidden.length > 0) {
    throw new ReleaseBuildError(
      `Refusing to ship local state or secrets in the release:\n  ${forbidden.join("\n  ")}`,
    );
  }
}

function readJournal(gatewayDir: string): ReleaseManifest["migrations"] {
  const journal = JSON.parse(
    fs.readFileSync(
      path.join(gatewayDir, "drizzle", "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map(({ tag, when }) => ({ tag, when }));
}

/**
 * An installed package's directory, found by walking node_modules up from
 * `fromDir` (not require.resolve: not every package exports package.json).
 */
function packageDir(name: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate);
    }
    if (path.dirname(dir) === dir) {
      throw new ReleaseBuildError(`Can't find ${name}; run pnpm install.`);
    }
  }
}

function packageVersion(name: string, fromDir: string): string {
  const manifest = path.join(packageDir(name, fromDir), "package.json");
  return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string })
    .version;
}

function git(args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: GATEWAY_DIR, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function run(command: string, args: string[]): void {
  console.log(`> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: GATEWAY_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new ReleaseBuildError(
      `${command} ${args.join(" ")} failed (exit ${result.status ?? result.signal})`,
    );
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const tarball = path.resolve(
    outIndex >= 0 && args[outIndex + 1]
      ? args[outIndex + 1]!
      : path.join(GATEWAY_DIR, TARBALL_NAME),
  );

  const cfDir = packageDir("cf", GATEWAY_DIR);
  if (!args.includes("--skip-build")) {
    // Production is cf's default mode; cf refuses --mode for TanStack Start.
    run(process.execPath, [path.join(cfDir, "bin", "cf"), "build"]);
  }

  const gatewayPackage = JSON.parse(
    fs.readFileSync(path.join(GATEWAY_DIR, "package.json"), "utf8"),
  ) as { version: string };
  const sha = git(["rev-parse", "HEAD"]) ?? "unknown";
  const dirty = Boolean(git(["status", "--porcelain"]));

  const stageDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "every-app-gateway-release-"),
  );
  try {
    const manifest = stageRelease({
      gatewayDir: GATEWAY_DIR,
      stageDir,
      build: {
        version: gatewayPackage.version,
        gitSha: dirty ? `${sha}-dirty` : sha,
        builtAt: new Date().toISOString(),
        cfVersion: packageVersion("cf", GATEWAY_DIR),
        pluginVersion: packageVersion("@cloudflare/vite-plugin", GATEWAY_DIR),
        configVersion: packageVersion("@cloudflare/config", cfDir),
        minCli: MIN_CLI_VERSION,
        minSdk: MIN_SDK_VERSION,
      },
    });
    fs.rmSync(tarball, { force: true });
    run("tar", ["-czf", tarball, "-C", stageDir, "."]);
    console.log(
      `\nGateway release ${manifest.version} (${manifest.sha256.slice(0, 12)}): ${tarball} (${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MiB)`,
    );
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
