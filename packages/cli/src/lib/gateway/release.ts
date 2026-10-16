/**
 * Gateway releases: the prebuilt Build Output, migrations and release.json
 * that apps/every-app-gateway/scripts/build-release.ts packs. The CLI builds
 * one from its checkout (commands/gateway/shared.ts), checks a release's
 * SHA-256 before using it, and keeps the live one in the account's
 * `every-app-gateway-deploy` KV namespace, so any checkout can redeploy
 * exactly the gateway that is live when it reconciles app bindings.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CfError } from "@/lib/cf/errors";
import { makeCfTempDir } from "@/lib/cf/privateDir";
import { onInterrupt } from "@/lib/interrupt";
import { runCfJson, type CfRunner } from "@/lib/cf/runner";
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
  cleanup(): Promise<void>;
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
    .filter((file) => file !== "release.json")
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const content = createHash("sha256")
      .update(await fsp.readFile(path.join(root, file)))
      .digest("hex");
    hash.update(`${file}\0${content}\n`);
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
export async function openRelease(tarball: string): Promise<GatewayRelease> {
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
    return { dir, tarball, manifest, cleanup };
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

/** The KV key the live release's tarball is cached under. */
function releaseCacheKey(sha256: string): string {
  return `release/${sha256}`;
}

const KvKeyList = z.array(z.looseObject({ name: z.string() }));

/** Store a release in the deploy KV namespace, unless it's there already. */
export async function cacheRelease(
  cf: CfRunner,
  deployKvId: string,
  release: GatewayRelease,
): Promise<"stored" | "present"> {
  const key = releaseCacheKey(release.manifest.sha256);
  const existing = await runCfJson(
    cf,
    {
      plane: "account",
      args: ["kv", "keys", "list", "--namespace-id", deployKvId, "--prefix", key],
    },
    KvKeyList,
  );
  if (existing.some((entry) => entry.name === key)) return "present";

  const encoded = (await fsp.readFile(release.tarball)).toString("base64");
  await cf.run({
    plane: "account",
    mode: "json",
    timeoutMs: 300_000,
    files: { "release.b64": encoded },
    args: (files) => [
      "kv",
      "keys",
      "put",
      key,
      "--namespace-id",
      deployKvId,
      "--file",
      files["release.b64"]!,
    ],
  });
  return "stored";
}

/**
 * The live release from the deploy KV namespace, checked against the
 * SHA-256 the install recorded; null when it isn't cached.
 */
export async function fetchCachedRelease(
  cf: CfRunner,
  deployKvId: string,
  sha256: string,
): Promise<GatewayRelease | null> {
  let stdout: string;
  try {
    ({ stdout } = await cf.run({
      plane: "account",
      mode: "json",
      timeoutMs: 300_000,
      args: [
        "kv",
        "keys",
        "get",
        releaseCacheKey(sha256),
        "--namespace-id",
        deployKvId,
      ],
    }));
  } catch (error) {
    if (error instanceof CfError && error.kind === "not_found") return null;
    throw error;
  }
  const trimmed = stdout.trim();
  // Raw value, or a JSON string if cf ever quotes it.
  const encoded = trimmed.startsWith('"') ? (JSON.parse(trimmed) as string) : trimmed;
  const dir = await makeCfTempDir("gateway-cached-");
  const forget = onInterrupt({
    sync: () => fs.rmSync(dir, { recursive: true, force: true }),
  });
  const removeDir = async () => {
    await fsp.rm(dir, { recursive: true, force: true });
    forget();
  };
  const tarball = path.join(dir, RELEASE_TARBALL);
  await fsp.writeFile(tarball, Buffer.from(encoded, "base64"));
  try {
    const release = await openRelease(tarball);
    if (release.manifest.sha256 !== sha256) {
      await release.cleanup();
      throw new EveryAppError(
        "RELEASE_CACHE_MISMATCH",
        `The cached gateway release ${releaseCacheKey(sha256)} holds release ${release.manifest.sha256} instead.`,
      );
    }
    return {
      ...release,
      cleanup: async () => {
        await release.cleanup();
        await removeDir();
      },
    };
  } catch (error) {
    await removeDir();
    throw error;
  }
}

/**
 * Where a release sits in the gateway's history. Not its version: the
 * gateway package's version doesn't change with every build, so an older
 * CLI's release can carry the same one. By its newest migration first
 * (drizzle's journal timestamps only grow along the history, and gateway
 * migrations only add), then by when it was built.
 */
export interface ReleaseOrder {
  /** `when` of the newest migration in the release's journal. */
  schema: number;
  /** Build time, ms since the epoch. */
  builtAt: number;
}

export function releaseOrder(
  manifest: Pick<ReleaseManifest, "migrations" | "builtAt">,
): ReleaseOrder {
  return {
    schema: Math.max(0, ...manifest.migrations.map((entry) => entry.when)),
    builtAt: Date.parse(manifest.builtAt) || 0,
  };
}

/** Negative when `a` is the older release. */
export function compareReleaseOrder(a: ReleaseOrder, b: ReleaseOrder): number {
  return a.schema - b.schema || a.builtAt - b.builtAt;
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
