/**
 * Gateway releases: the prebuilt Build Output, migrations and release.json
 * that apps/every-app-gateway/scripts/build-release.ts packs. The CLI only
 * deploys one built from the checkout it runs in (./checkoutRelease.ts),
 * and checks its SHA-256 before using it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { makeCfTempDir } from "@/lib/cf/privateDir";
import { onInterrupt } from "@/lib/interrupt";
import { EveryAppError } from "@/lib/errors";

export const RELEASE_TARBALL = "every-app-gateway-release.tar.gz";
const SUPPORTED_BUILD_OUTPUT = "v0";
/**
 * All a release holds at its top level. cf deploys from a copy of it, so
 * anything else there (a cloudflare.config.ts above all) would be run.
 */
const RELEASE_ENTRIES = new Set([".cloudflare", "drizzle", "release.json"]);

const ReleaseManifestSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  gitSha: z.string(),
  builtAt: z.string(),
  cfVersion: z.string(),
  pluginVersion: z.string(),
  configVersion: z.string(),
  buildOutputVersion: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  migrations: z.array(z.object({ tag: z.string(), when: z.number() })),
  minCli: z.string(),
  minSdk: z.string(),
});
type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

export interface GatewayRelease {
  /** Extracted, private to this run. */
  dir: string;
  tarball: string;
  manifest: ReleaseManifest;
  /** What it was built from. */
  source: ReleaseSource;
  cleanup(): Promise<void>;
}

/** The checkout a release was built from, as far as the CLI knows it. */
export interface ReleaseSource {
  /**
   * `hashCheckoutTree` of the Gateway's sources it was built from; null
   * for a release that didn't come from this checkout (tests).
   */
  treeSha256: string | null;
  /** Where it sits in the Gateway's history. */
  order: ReleaseOrder;
}

/**
 * SHA-256 over every file under `root` except release.json: each file's
 * relative path and the SHA-256 of its contents, in path order. The same as
 * the release builder's `hashTree`.
 */
export async function hashReleaseTree(root: string): Promise<string> {
  const files = (
    await fsp.readdir(root, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(root, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .filter((file) => file !== "release.json");
  return hashFiles(root, files);
}

/**
 * SHA-256 over `files` (relative to `root`, `/`-separated): each one's path
 * and the SHA-256 of its contents, in path order. A file listed but gone
 * counts as one with no contents.
 */
export async function hashFiles(
  root: string,
  files: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    let content: Buffer;
    try {
      content = await fsp.readFile(path.join(root, file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(`${file}\0-\n`);
      continue;
    }
    hash.update(`${file}\0${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}

function extractTarGz(tarball: string, dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = spawn("tar", ["-xzf", tarball, "-C", dir], { stdio: "ignore" });
    tar.once("error", reject);
    tar.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`tar couldn't extract ${tarball} (exit ${code})`)),
    );
  });
}

/**
 * Extract a release into a private temp dir and check it: only a release's
 * own files, in a format this CLI deploys, whose SHA-256 is the one
 * release.json records.
 */
export async function openRelease(
  tarball: string,
  /** What the checkout says of it; without, its build time orders it. */
  checkout: { treeSha256: string | null; committedAt: number | null } = {
    treeSha256: null,
    committedAt: null,
  },
): Promise<GatewayRelease> {
  const dir = await makeCfTempDir("gateway-release-");
  const forget = onInterrupt({
    sync: () => fs.rmSync(dir, { recursive: true, force: true }),
  });
  const cleanup = async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    forget();
  };
  try {
    await extractTarGz(tarball, dir);
    const unexpected = (await fsp.readdir(dir)).filter(
      (entry) => !RELEASE_ENTRIES.has(entry),
    );
    if (unexpected.length > 0) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} holds more than a gateway release: ${unexpected.join(", ")}.`,
      );
    }
    const parsed = ReleaseManifestSchema.safeParse(
      JSON.parse(await fsp.readFile(path.join(dir, "release.json"), "utf8")),
    );
    if (!parsed.success) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} has no valid release.json: ${parsed.error.issues[0]?.message}`,
      );
    }
    const manifest = parsed.data;
    if (manifest.buildOutputVersion !== SUPPORTED_BUILD_OUTPUT) {
      throw new EveryAppError(
        "RELEASE_UNSUPPORTED",
        `Gateway release ${manifest.version} uses Build Output ${manifest.buildOutputVersion}; this everyapp deploys ${SUPPORTED_BUILD_OUTPUT}. Upgrade everyapp.`,
      );
    }
    const actual = await hashReleaseTree(dir);
    if (actual !== manifest.sha256) {
      throw new EveryAppError(
        "RELEASE_CORRUPT",
        `Gateway release ${manifest.version} doesn't match its SHA-256 (expected ${manifest.sha256}, got ${actual}).`,
      );
    }
    const order = releaseOrder(manifest);
    const source = {
      treeSha256: checkout.treeSha256,
      order: { ...order, committedAt: checkout.committedAt ?? order.committedAt },
    };
    return { dir, tarball, manifest, source, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} isn't a gateway release: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

/**
 * Where a release sits in the gateway's history. Not its version: the
 * gateway package's version doesn't change with every commit, so an older
 * checkout's release can carry the same one. Nor when it was built: an
 * old checkout builds today, and the build cache hands back a release built
 * days ago. By its newest migration first (drizzle's journal timestamps
 * only grow along the history, and gateway migrations only add), then by
 * when its sources were last committed (checkoutRelease.ts), which is the
 * same on every machine at the same commit.
 */
export interface ReleaseOrder {
  /** `when` of the newest migration in the release's journal. */
  schema: number;
  /**
   * When the Gateway's sources were last committed, ms since the epoch;
   * the build time for a release that came without its checkout.
   */
  committedAt: number;
}

/** A release's order from its manifest alone: by build time. */
function releaseOrder(
  manifest: Pick<ReleaseManifest, "migrations" | "builtAt">,
): ReleaseOrder {
  return {
    schema: newestMigration(manifest.migrations),
    committedAt: Date.parse(manifest.builtAt) || 0,
  };
}

/** `when` of the newest migration in a drizzle journal. */
export function newestMigration(
  migrations: ReadonlyArray<{ when: number }>,
): number {
  return Math.max(0, ...migrations.map((entry) => entry.when));
}

/** Negative when `a` is the older release. */
export function compareReleaseOrder(a: ReleaseOrder, b: ReleaseOrder): number {
  return a.schema - b.schema || a.committedAt - b.committedAt;
}

/** Compare dotted versions, prerelease suffixes ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) =>
    version
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
