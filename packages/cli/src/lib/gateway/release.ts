/**
 * Gateway releases: the prebuilt Build Output, migrations and release.json
 * that apps/every-app-gateway/scripts/build-release.ts packs. One comes
 * from the checkout the CLI runs in (./checkoutRelease.ts), a GitHub
 * release, a URL or a file (./source.ts); either way the CLI checks its
 * SHA-256 before using it.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { privateTempDir } from "@/lib/cf/privateDir";
import { EveryAppError } from "@/lib/errors";
import { isNotFoundError } from "@/lib/file-operations";

export const RELEASE_TARBALL = "every-app-gateway-release.tar.gz";
/**
 * Where a CLI with no checkout takes the Gateway from: the latest release
 * of this repository with a {@link RELEASE_TARBALL} asset
 * (.github/workflows/release.yml publishes them).
 */
export const GATEWAY_RELEASE_REPO = "https://github.com/every-app/every-app";
const SUPPORTED_BUILD_OUTPUT = "v0";
/** What a release deploys: the Gateway, or an app (lib/app/release.ts). */
type ReleaseKind = "gateway" | "app";

/**
 * All a release of each kind holds at its top level. cf deploys from a
 * copy of it, so anything else there (a cloudflare.config.ts above all)
 * would be run.
 */
const RELEASE_ENTRIES: Record<ReleaseKind, ReadonlySet<string>> = {
  gateway: new Set([".cloudflare", "drizzle", "release.json"]),
  app: new Set([".cloudflare", "migrations", "release.json"]),
};

/** release.json's fields every kind of release has. */
export const BaseReleaseSchema = z.looseObject({
  schema: z.literal(1),
  /** What the release deploys; a Gateway when absent. */
  kind: z.string().optional(),
  version: z.string(),
  gitSha: z.string(),
  builtAt: z.string(),
  cfVersion: z.string(),
  buildOutputVersion: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  migrations: z.array(z.object({ tag: z.string(), when: z.number() })),
  minCli: z.string(),
  minSdk: z.string(),
});

const ReleaseManifestSchema = BaseReleaseSchema.extend({
  /** When the Gateway's sources were last committed (ISO), if git said. */
  committedAt: z.string().optional(),
  pluginVersion: z.string(),
  configVersion: z.string(),
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

/** Where a release came from, as setup and the downgrade guard say it. */
export type ReleaseOrigin =
  | { kind: "checkout" }
  | { kind: "github"; repo: string; tag: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string };

/** What a release was built from, as far as the CLI knows it. */
interface ReleaseSource {
  /**
   * `hashCheckoutTree` of the Gateway's sources it was built from; null
   * for a release that didn't come from this checkout.
   */
  treeSha256: string | null;
  /** Where it sits in the Gateway's history. */
  order: ReleaseOrder;
  origin: ReleaseOrigin;
}

/**
 * A Gateway as the downgrade guard compares it with the live one
 * (lib/gateway/apply.ts `olderThanInstalled`): a release this run opened,
 * or what the checkout's sources say before it is built.
 */
export interface CandidateRelease extends ReleaseSource {
  /** The Gateway package's version. */
  version: string;
  /** Its SHA-256, once it is built. */
  sha256?: string;
  /** The oldest everyapp that deploys it, once a release says. */
  minCli?: string;
}

/** "this checkout", "every-app/every-app release gateway-v0.3.0", a URL or a path. */
export function describeOrigin(origin: ReleaseOrigin): string {
  switch (origin.kind) {
    case "checkout":
      return "this checkout";
    case "github":
      return `${origin.repo} release ${origin.tag}`;
    case "url":
      return origin.url;
    case "file":
      return origin.path;
  }
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
      if (!isNotFoundError(error)) throw error;
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

const RELEASE_NAMES: Record<ReleaseKind, { a: string; the: string }> = {
  gateway: { a: "a gateway release", the: "Gateway release" },
  app: { a: "an app release", the: "App release" },
};

/**
 * Extract a release of `kind` into a private temp dir and check what every
 * release must be: only that kind's own files, a release.json of that kind
 * that `schema` reads, in a Build Output format this CLI deploys, whose
 * SHA-256 is the one release.json records.
 */
export async function extractRelease<T extends z.infer<typeof BaseReleaseSchema>>(
  tarball: string,
  kind: ReleaseKind,
  schema: z.ZodType<T>,
): Promise<{ dir: string; manifest: T; cleanup(): Promise<void> }> {
  const names = RELEASE_NAMES[kind];
  const { dir, cleanup } = await privateTempDir(`${kind}-release-`);
  try {
    await extractTarGz(tarball, dir);
    const json: unknown = JSON.parse(
      await fsp.readFile(path.join(dir, "release.json"), "utf8"),
    );
    const said = (json as { kind?: unknown } | null)?.kind ?? "gateway";
    if (said !== kind) {
      const other = said === "app" || said === "gateway" ? RELEASE_NAMES[said].a : `a ${String(said)} release`;
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} is ${other}, not ${kind === "gateway" ? "a Gateway release" : names.a}.`,
      );
    }
    const unexpected = (await fsp.readdir(dir)).filter(
      (entry) => !RELEASE_ENTRIES[kind].has(entry),
    );
    if (unexpected.length > 0) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} holds more than ${names.a}: ${unexpected.join(", ")}.`,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} isn't a valid ${names.the.toLowerCase()}\nIts release.json is malformed: ${parsed.error.issues[0]?.message}`,
      );
    }
    const manifest = parsed.data;
    if (manifest.buildOutputVersion !== SUPPORTED_BUILD_OUTPUT) {
      throw new EveryAppError(
        "RELEASE_UNSUPPORTED",
        `${names.the} ${manifest.version} needs a newer everyapp`,
        {
          fix: "update everyapp (in a checkout: git pull), then run this again",
          data: {
            buildOutputVersion: manifest.buildOutputVersion,
            supported: SUPPORTED_BUILD_OUTPUT,
          },
        },
      );
    }
    const actual = await hashReleaseTree(dir);
    if (actual !== manifest.sha256) {
      throw new EveryAppError(
        "RELEASE_CORRUPT",
        `${names.the} ${manifest.version} doesn't match its checksum\nThe download may be damaged. Download it again.`,
        { data: { expected: manifest.sha256, actual } },
      );
    }
    return { dir, manifest, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof SyntaxError || isNotFoundError(error)) {
      throw new EveryAppError(
        "RELEASE_INVALID",
        `${tarball} isn't ${names.a}: ${(error as Error).message}`,
      );
    }
    throw error;
  }
}

/** Open a Gateway release and check it (see {@link extractRelease}). */
export async function openRelease(
  tarball: string,
  /**
   * Where it came from (the file itself, unless said), and what a checkout
   * says of it; without one, release.json orders it.
   */
  from: {
    origin: ReleaseOrigin;
    treeSha256?: string | null;
    committedAt?: number | null;
  } = { origin: { kind: "file", path: tarball } },
): Promise<GatewayRelease> {
  const { dir, manifest, cleanup } = await extractRelease(
    tarball,
    "gateway",
    ReleaseManifestSchema,
  );
  const order = releaseOrder(manifest);
  const source = {
    treeSha256: from.treeSha256 ?? null,
    order: { ...order, committedAt: from.committedAt ?? order.committedAt },
    origin: from.origin,
  };
  return { dir, tarball, manifest, source, cleanup };
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
   * When the Gateway's sources were last committed, ms since the epoch:
   * the checkout's, or for a release without one, its release.json's (the
   * build time, from a builder that couldn't ask git).
   */
  committedAt: number;
}

/** A release's order from its manifest alone. */
function releaseOrder(
  manifest: Pick<ReleaseManifest, "migrations" | "builtAt" | "committedAt">,
): ReleaseOrder {
  return {
    schema: newestMigration(manifest.migrations),
    committedAt:
      Date.parse(manifest.committedAt ?? "") || Date.parse(manifest.builtAt) || 0,
  };
}

/**
 * A release that needs a newer everyapp than this one to deploy it is
 * refused before anything changes.
 */
export function refuseNewerThanCli(
  manifest: Pick<ReleaseManifest, "version" | "minCli">,
  cliVersion: string,
  /** What the release is, as the message names it. */
  what = `Gateway ${manifest.version}`,
): void {
  if (compareVersions(manifest.minCli, cliVersion) > 0) {
    throw new EveryAppError(
      "CLI_TOO_OLD",
      `${what} needs everyapp ${manifest.minCli} or newer (this is ${cliVersion})`,
      {
        fix: "update everyapp (in a checkout: git pull), then run this again",
        data: { minCli: manifest.minCli, cliVersion },
      },
    );
  }
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
