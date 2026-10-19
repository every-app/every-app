/**
 * When everyapp runs from a checkout (and `setup` has no --release:
 * ./source.ts), every Gateway deploy, a rebind for an app's deploy or
 * delete included, deploys a release built from it
 * (`openCheckoutGatewayRelease` below: the SDK's build, then the Gateway's
 * `build:release`, one to two minutes). So that a rebind after the first
 * build takes seconds, the built tarball is kept under the checkout's gitignored
 * `node_modules/.cache/everyapp/<tree>.tar.gz`, keyed by the tree hash of
 * every source the release is built from: the Gateway, the SDK, perimeter
 * and toolbus (which it bundles), and the workspace settings their
 * lockfiles resolve with. Any edit there, committed or not, a `git pull`
 * included, is another key. The cache is a build artefact, not state:
 * deleting it costs one build.
 *
 * Without building anything, `checkoutSource` says what the checkout's
 * Gateway is: that tree hash, its version and newest migration, and when
 * its sources were last committed, by which the downgrade guard orders it
 * against the live one (lib/gateway/apply.ts `olderThanInstalled`).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runLogged } from "@/lib/childLog";
import type { EventSink } from "@/lib/output/events";
import {
  hashFiles,
  newestMigration,
  openRelease,
  RELEASE_TARBALL,
  type GatewayRelease,
  type ReleaseSource,
} from "./release";

/** What a Gateway release is built from, relative to the checkout's root. */
const GATEWAY_SOURCES = [
  "apps/every-app-gateway",
  "packages/sdk",
  "packages/perimeter",
  "packages/toolbus",
  "pnpm-workspace.yaml",
];

/** How many builds the cache keeps: the latest, and a few to switch back to. */
const KEEP_BUILDS = 3;

/** Where built releases are kept, by tree hash. */
export function releaseCacheDir(root: string): string {
  return path.join(root, "node_modules", ".cache", "everyapp");
}

/**
 * The tree hash of the Gateway's sources in the checkout at `root`: every
 * file git tracks or would (`git ls-files --cached --others
 * --exclude-standard`, so nothing it ignores: node_modules, build output,
 * local secrets), as it is on disk, hashed like a release's own tree
 * (`hashFiles`). Null when git can't list the checkout.
 */
export async function hashCheckoutTree(root: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...GATEWAY_SOURCES],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  const files = [...new Set(stdout.split("\0").filter(Boolean))];
  return files.length > 0 ? hashFiles(root, files) : null;
}

/**
 * When the Gateway's sources were last committed in this checkout (ms):
 * the same on every machine at that commit, and older on a checkout behind
 * it, whenever it builds. Null without git.
 */
async function sourcesCommittedAt(root: string): Promise<number | null> {
  try {
    const { stdout } = await promisify(execFile)(
      "git",
      ["log", "-1", "--format=%ct", "--", ...GATEWAY_SOURCES],
      { cwd: root },
    );
    const seconds = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** What the checkout's Gateway is, without building it. */
export interface CheckoutSource extends ReleaseSource {
  /** The Gateway package's version. */
  version: string;
}

/**
 * The release this checkout would build, as far as its sources tell:
 * their tree hash, the Gateway's version, its newest migration and when
 * its sources were last committed (now, without git: a checkout git can't
 * read is never called older).
 */
export async function checkoutSource(root: string): Promise<CheckoutSource> {
  const gatewayDir = path.join(root, "apps", "every-app-gateway");
  const readJson = async (file: string) =>
    JSON.parse(await fs.readFile(path.join(gatewayDir, file), "utf8")) as unknown;
  const [treeSha256, committedAt, journal, pkg] = await Promise.all([
    hashCheckoutTree(root),
    sourcesCommittedAt(root),
    readJson("drizzle/meta/_journal.json"),
    readJson("package.json"),
  ]);
  return {
    treeSha256,
    origin: { kind: "checkout" },
    version: String((pkg as { version?: unknown }).version ?? "unknown"),
    order: {
      schema: newestMigration((journal as { entries?: Array<{ when: number }> }).entries ?? []),
      committedAt: committedAt ?? Date.now(),
    },
  };
}

/**
 * The Gateway release this checkout builds: the cached one for its tree
 * hash, or a new build, cached once the tree is still the one it was built
 * from.
 */
export async function openCheckoutRelease({
  root,
  out,
  build,
  keep = KEEP_BUILDS,
}: {
  root: string;
  out: EventSink;
  /** Builds the release from the checkout and returns its tarball. */
  build: () => Promise<string>;
  keep?: number;
}): Promise<GatewayRelease> {
  const [tree, committedAt] = await Promise.all([
    hashCheckoutTree(root),
    sourcesCommittedAt(root),
  ]);
  const cacheDir = releaseCacheDir(root);
  const cached = tree ? path.join(cacheDir, `${tree}.tar.gz`) : null;
  const source = { origin: { kind: "checkout" } as const, treeSha256: tree, committedAt };

  if (cached && (await exists(cached))) {
    try {
      const release = await openRelease(cached, source);
      const now = new Date();
      await fs.utimes(cached, now, now);
      out.emit({
        type: "step",
        step: "gateway.release",
        status: "ok",
        message: `Using the Gateway ${release.manifest.version} built from this checkout before (${tree!.slice(0, 12)}).`,
        data: { cached: true, treeSha256: tree, release: release.manifest.version },
      });
      return release;
    } catch {
      // Damaged: build it again.
      await fs.rm(cached, { force: true });
    }
  }

  const tarball = await build();
  // Cached only if nothing changed while it built.
  if (cached && (await hashCheckoutTree(root)) === tree) {
    await store(tarball, cached, keep);
  }
  const release = await openRelease(tarball, {
    origin: { kind: "checkout" },
    treeSha256: cached && (await exists(cached)) ? tree : null,
    committedAt,
  });
  out.emit({
    type: "step",
    step: "gateway.release",
    status: "ok",
    message: `Built the Gateway ${release.manifest.version} from this checkout.`,
    data: { cached: false, treeSha256: release.source.treeSha256, release: release.manifest.version },
  });
  return release;
}

/** Keep `tarball` as `target`, and only the `keep` most recently used builds. */
async function store(tarball: string, target: string, keep: number): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  await fs.copyFile(tarball, partial);
  await fs.rename(partial, target);
  const builds = await Promise.all(
    (await fs.readdir(dir))
      .filter((name) => name.endsWith(".tar.gz"))
      .map(async (name) => ({
        file: path.join(dir, name),
        usedAt: (await fs.stat(path.join(dir, name))).mtimeMs,
      })),
  );
  for (const { file } of builds
    .sort((a, b) => b.usedAt - a.usedAt)
    .slice(keep)) {
    if (file !== target) await fs.rm(file, { force: true });
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Gateway release the checkout at `root` builds, from the build cache
 * when its sources haven't changed since.
 */
export function openCheckoutGatewayRelease({
  root,
  out,
  verbose,
}: {
  root: string;
  out: EventSink;
  /** Stream the build's output to stderr too. */
  verbose?: boolean;
}): Promise<GatewayRelease> {
  return openCheckoutRelease({
    root,
    out,
    build: () => buildReleaseFromCheckout(root, out, verbose ?? false),
  });
}

/**
 * A Gateway release from the checkout: the SDK's build, then the
 * Gateway's `build:release`. Their output goes to a log file
 * (lib/childLog.ts).
 */
async function buildReleaseFromCheckout(
  root: string,
  out: EventSink,
  verbose: boolean,
): Promise<string> {
  const gatewayDir = path.join(root, "apps", "every-app-gateway");
  out.emit({
    type: "progress",
    step: "gateway.release",
    message: "Building the Gateway from this checkout (a minute or two)...",
    data: { dir: gatewayDir },
  });
  const build = (args: string[], cwd: string) =>
    runLogged("pnpm", args, {
      cwd,
      echo: verbose,
      what: "Building the Gateway",
      code: "GATEWAY_BUILD_FAILED",
    });
  // The gateway build resolves @every-app/sdk from its dist/.
  await build(["--filter", "@every-app/sdk", "build"], root);
  await build(["run", "build:release"], gatewayDir);
  return path.join(gatewayDir, RELEASE_TARBALL);
}
