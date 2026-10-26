/**
 * App releases: an app's tenant-neutral Build Output, its migrations and a
 * release.json, packed by `everyapp release` (CI publishes it
 * on a GitHub release as {@link APP_RELEASE_TARBALL}) and deployed by
 * `everyapp install <github url | tarball>` with no checkout of the app:
 *
 *   release.json                    schema 1, kind "app": the app id, its
 *                                   version, toolchain, sha256, migration
 *                                   journal, evaluated manifest and the
 *                                   provider specs the app bundles
 *                                   (`providers`: .everyapp/providers/*.json,
 *                                   which `install` registers)
 *   .cloudflare/output/v0/...       the Build Output, placeholders and all
 *   migrations/                     the manifest's migrations directory,
 *                                   as it is (when there is one)
 *
 * The SHA-256 is lib/gateway/release.ts `hashReleaseTree` (the gateway's
 * reader, apps/every-app-gateway/src/server/deploy/release.ts, computes
 * it the same way). Packing refuses local state and a
 * Build Output that isn't a production build; opening checks what
 * `extractRelease` checks, then the manifest and the CLI version.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import { ManifestError, validateManifestStrict } from "@every-app/perimeter/manifest";
import { cliVersion } from "@/lib/version";
import { privateTempDir } from "@/lib/cf/privateDir";
import { EveryAppError } from "@/lib/errors";
import { isNotFoundError } from "@/lib/file-operations";
import { CLI } from "@/lib/output/command";
import {
  BaseReleaseSchema,
  extractRelease,
  hashReleaseTree,
  refuseNewerThanCli,
  type ReleaseOrigin,
} from "@/lib/gateway/release";
import {
  LOCAL_MANIFEST_OPTIONS,
  migrationsDir,
  resolveMigrationBinding,
  type EveryAppCliManifest,
} from "@/lib/manifest";
import type { EventSink } from "@/lib/output/events";
import { fetchReleaseTarball, githubRepository, isUrl } from "@/lib/release/fetch";
import { readBundledProviderSpecs } from "./bundledProviders";
import { isProductionBuild } from "./buildOutput";

/** The asset an app's GitHub release carries. */
export const APP_RELEASE_TARBALL = "everyapp-release.tar.gz";
/** Where a release keeps the app's migrations; its manifest's `migrations.dir`. */
const RELEASE_MIGRATIONS_DIR = "migrations";
const BUILD_OUTPUT_DIR = path.join(".cloudflare", "output");
const BUILD_OUTPUT_VERSION = "v0";
/** The oldest everyapp and SDK that can deploy and run what this CLI packs. */
const MIN_CLI_VERSION = "0.3.0";
const MIN_SDK_VERSION = "0.3.0";
/** Never staged: what macOS leaves beside files. Tar readers see them as files. */
const OS_LITTER = /^(\.DS_Store|\._.*)$/;

/** The app's own @every-app/sdk version, when it has one installed. */
function appSdkVersion(cwd: string): string | null {
  try {
    const require = createRequire(path.join(cwd, "package.json"));
    return (require("@every-app/sdk/package.json") as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

const AppReleaseSchema = BaseReleaseSchema.extend({
  kind: z.literal("app"),
  appId: z.string().min(1),
  cliVersion: z.string(),
  sdkVersion: z.string().nullable(),
  manifest: z.record(z.string(), z.unknown()),
  /** The specs the app bundled (`.everyapp/providers/*.json`), for `install` to register. */
  providers: z.array(z.unknown()).max(50).optional(),
});
type AppReleaseManifest = z.infer<typeof AppReleaseSchema>;

export interface AppRelease {
  /** Extracted, private to this run: the Build Output root. */
  dir: string;
  release: AppReleaseManifest;
  /** release.json's manifest, validated as the app's own would be. */
  manifest: EveryAppCliManifest;
  origin: ReleaseOrigin;
  /** Delete the extracted release, and the download it came from. */
  cleanup(): Promise<void>;
}

/** "github.com/acme/todo (release v1.4.0)", a URL or a path. */
export function describeAppOrigin(origin: ReleaseOrigin): string {
  switch (origin.kind) {
    case "github":
      return `github.com/${origin.repo} (release ${origin.tag})`;
    case "url":
      return origin.url;
    case "file":
      return origin.path;
    case "checkout":
      return "this checkout";
  }
}

/**
 * The migrations directory the manifest names, relative to the app, when
 * it migrates a database; null when it doesn't.
 */
function releasedMigrationsDir(manifest: EveryAppCliManifest): string | null {
  if (manifest.migrations?.engine === "prisma") {
    throw new EveryAppError(
      "RELEASE_MIGRATIONS_UNSUPPORTED",
      `${manifest.id} migrates with Prisma, which a release can't carry\nPrisma migrations (migrations.engine "prisma") need the app's source and its Prisma CLI.`,
      { rerun: `${CLI} deploy`, rerunNote: "from a clone of the app, after pnpm install in it" },
    );
  }
  if (manifest.migrations?.dialect === "postgresql") return migrationsDir(manifest);
  const bindings = manifest.resources?.d1 ?? [];
  if (bindings.length === 0) return null;
  resolveMigrationBinding(bindings, manifest.migrations);
  return migrationsDir(manifest);
}

/** Files under `root`, relative and `/`-separated. */
async function listFiles(root: string): Promise<string[]> {
  return (await fsp.readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) =>
      path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

/** Nothing local or secret may ship. */
async function checkStagedFiles(stageDir: string): Promise<void> {
  const forbidden = (await listFiles(stageDir)).filter((file) => {
    const base = path.posix.basename(file);
    return (
      base.startsWith(".dev.vars") ||
      base.startsWith(".env") ||
      base.endsWith(".pem") ||
      /(^|\/)\.cloudflare\/(state|types)(\/|$)/.test(file) ||
      /(^|\/)\.(wrangler|everyapp)(\/|$)/.test(file)
    );
  });
  if (forbidden.length > 0) {
    throw new EveryAppError(
      "RELEASE_LOCAL_STATE",
      `Refusing to pack local state or secrets into the release:\n  ${forbidden.join("\n  ")}`,
    );
  }
}

async function readJournal(dir: string): Promise<Array<{ tag: string; when: number }>> {
  let text: string;
  try {
    text = await fsp.readFile(path.join(dir, "meta", "_journal.json"), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  const journal = JSON.parse(text) as { entries?: Array<{ tag: string; when: number }> };
  return (journal.entries ?? []).map(({ tag, when }) => ({ tag, when }));
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function runTar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // No AppleDouble (._*) entries: readers of the release refuse them.
    const tar = spawn("tar", args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    let stderr = "";
    tar.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    tar.once("error", reject);
    tar.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new EveryAppError("RELEASE_PACK_FAILED", `tar couldn't pack the release (exit ${code}): ${stderr.trim()}`)),
    );
  });
}

/**
 * Pack the app built in `cwd` (its Build Output already checked) into
 * `outFile` as an app release.
 */
export async function packAppRelease({
  cwd,
  manifest,
  outFile,
  cfVersion,
  builtAt = new Date(),
}: {
  cwd: string;
  manifest: EveryAppCliManifest;
  outFile: string;
  cfVersion: string;
  builtAt?: Date;
}): Promise<AppReleaseManifest> {
  const outputRoot = path.join(cwd, BUILD_OUTPUT_DIR);
  const versions = fs.existsSync(outputRoot)
    ? (await fsp.readdir(outputRoot)).filter((entry) => !OS_LITTER.test(entry))
    : [];
  if (versions.length !== 1 || versions[0] !== BUILD_OUTPUT_VERSION) {
    throw new EveryAppError(
      "RELEASE_PACK_FAILED",
      `Expected the Build Output ${BUILD_OUTPUT_VERSION} alone in ${outputRoot}, found ${versions.length ? versions.join(", ") : "none"}.`,
    );
  }
  const outputDir = path.join(outputRoot, BUILD_OUTPUT_VERSION);
  if (!(await isProductionBuild(outputDir))) {
    throw new EveryAppError(
      "RELEASE_PACK_FAILED",
      "The app's Build Output isn't a production build\nA release ships only one.",
      { fix: "build with `cf build` (production by default)" },
    );
  }
  const migrations = releasedMigrationsDir(manifest);
  // The specs the app bundles ride in release.json: a spec names settings
  // and never holds a value, and `.everyapp/` itself never ships.
  const providers = (await readBundledProviderSpecs(cwd)).map(({ file, spec }) => {
    if (typeof spec === "string") {
      throw new EveryAppError("RELEASE_PACK_FAILED", `${file} isn't JSON\nA release carries the app's provider specs; fix or delete the file.`);
    }
    return spec;
  });

  const { dir: stageDir, cleanup } = await privateTempDir("app-release-stage-");
  try {
    const copy = (from: string, to: string) =>
      fsp.cp(from, path.join(stageDir, to), {
        recursive: true,
        dereference: true,
        filter: (source) => !OS_LITTER.test(path.basename(source)),
      });
    await copy(outputDir, path.join(BUILD_OUTPUT_DIR, BUILD_OUTPUT_VERSION));
    const migrationsFrom = migrations ? path.resolve(cwd, migrations) : null;
    const hasMigrations =
      migrationsFrom !== null && fs.existsSync(migrationsFrom) && fs.statSync(migrationsFrom).isDirectory();
    if (hasMigrations) await copy(migrationsFrom, RELEASE_MIGRATIONS_DIR);
    await checkStagedFiles(stageDir);

    const packageJson = JSON.parse(
      await fsp.readFile(path.join(cwd, "package.json"), "utf8").catch(() => "{}"),
    ) as { version?: string };
    const sha = git(cwd, ["rev-parse", "HEAD"]);
    const dirty = sha !== null && Boolean(git(cwd, ["status", "--porcelain", "--", "."]));
    const release: AppReleaseManifest = {
      schema: 1,
      kind: "app",
      appId: manifest.id,
      version: packageJson.version ?? "0.0.0",
      gitSha: sha ? `${sha}${dirty ? "-dirty" : ""}` : "unknown",
      builtAt: builtAt.toISOString(),
      cfVersion,
      cliVersion,
      sdkVersion: appSdkVersion(cwd),
      buildOutputVersion: BUILD_OUTPUT_VERSION,
      sha256: await hashReleaseTree(stageDir),
      migrations: hasMigrations ? await readJournal(path.join(stageDir, RELEASE_MIGRATIONS_DIR)) : [],
      minCli: MIN_CLI_VERSION,
      minSdk: MIN_SDK_VERSION,
      ...(providers.length > 0 ? { providers } : {}),
      // Its migrations, wherever the app keeps them, are migrations/ here.
      manifest: (manifest.migrations || hasMigrations
        ? {
            ...manifest,
            migrations: { engine: "drizzle", ...manifest.migrations, dir: RELEASE_MIGRATIONS_DIR },
          }
        : manifest) as Record<string, unknown>,
    };
    await fsp.writeFile(path.join(stageDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
    await fsp.mkdir(path.dirname(outFile), { recursive: true });
    await fsp.rm(outFile, { force: true });
    await runTar(["-czf", outFile, "-C", stageDir, "."]);
    return release;
  } finally {
    await cleanup();
  }
}

/**
 * Open an app release and check it: what every release must be
 * (`extractRelease`), an everyapp new enough for it, and a manifest that
 * is valid, the app's, and keeps its migrations in the release.
 */
export async function openAppRelease(
  tarball: string,
  {
    origin = { kind: "file", path: tarball },
    version = cliVersion,
  }: { origin?: ReleaseOrigin; version?: string } = {},
): Promise<AppRelease> {
  const { dir, manifest: release, cleanup } = await extractRelease(tarball, "app", AppReleaseSchema);
  try {
    refuseNewerThanCli(release, version, `${release.appId} ${release.version}`);
    let manifest: EveryAppCliManifest;
    try {
      // The ids it lists are checked against the Gateway when it is deployed.
      manifest = validateManifestStrict(release.manifest, LOCAL_MANIFEST_OPTIONS);
    } catch (error) {
      if (!(error instanceof ManifestError)) throw error;
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} carries a manifest this everyapp refuses: ${error.message}`,
      );
    }
    if (manifest.id !== release.appId) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} says it is ${release.appId}, but its manifest is ${manifest.id}'s.`,
      );
    }
    const dirName = manifest.migrations?.dir;
    if (dirName !== undefined && dirName !== RELEASE_MIGRATIONS_DIR) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball}'s manifest keeps its migrations in ${dirName}; a release keeps them in ${RELEASE_MIGRATIONS_DIR}/.`,
      );
    }
    return { dir, release, manifest, origin, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * The release `source` names (`everyapp install <source>`), downloaded and
 * opened: a GitHub repository's latest release (or `/releases/tag/<tag>`),
 * a tarball's HTTPS URL, or a local tarball. A repository that publishes
 * none is never built from its source here: whoever deploys it clones it.
 */
export async function fetchAppRelease(
  source: string,
  { out, fetch: fetchImpl, version }: { out: EventSink; fetch?: typeof fetch; version?: string },
): Promise<AppRelease> {
  const repo = isUrl(source) ? githubRepository(source) : null;
  let fetched;
  try {
    fetched = await fetchReleaseTarball(source, {
      asset: APP_RELEASE_TARBALL,
      what: "the app",
      step: "app.release",
      missing: `${source} is neither a URL nor a file\nPass a GitHub repository URL (https://github.com/<owner>/<repo>), a release tarball's URL, or a downloaded ${APP_RELEASE_TARBALL}.`,
      out,
      fetch: fetchImpl,
    });
  } catch (error) {
    if (repo && error instanceof EveryAppError && error.code === "RELEASE_NOT_FOUND") {
      throw new EveryAppError(
        "NO_RELEASE",
        `${repo.repo} publishes no everyapp release${repo.tag ? ` ${repo.tag}` : ""}\nIts GitHub releases have no ${APP_RELEASE_TARBALL}.`,
        { fix: `clone it, run pnpm install in it, then ${CLI} deploy from its directory` },
      );
    }
    throw error;
  }
  try {
    const opened = await openAppRelease(fetched.tarball, { origin: fetched.origin, version });
    return {
      ...opened,
      cleanup: async () => {
        await opened.cleanup();
        await fetched.cleanup();
      },
    };
  } catch (error) {
    await fetched.cleanup();
    throw error;
  }
}
