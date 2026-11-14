/**
 * The Gateway releases kept in the Gateway's own Cloudflare account, so
 * that an app command's rebind (./liveRelease.ts) finds the live release on
 * any machine: an R2 bucket per Gateway (`GatewayNames.releases`), one
 * object per release, the release tarball as it was deployed, under
 * `<release SHA-256>.tar.gz`. The design, and why R2:
 * docs/design/2026-11-gateway-release-store.md.
 *
 * Every deploy of the Gateway (./apply.ts) saves its release before the
 * upload, so the release the install row names is there whenever a save
 * worked; after the upload it removes all but the live one and the two
 * saved most recently besides. The bucket is created by the first save.
 *
 * What comes back is checked like any release (./release.ts
 * `openRelease`: its files hash to the SHA-256 its release.json records)
 * and the caller checks that SHA-256 is the install row's, so an object
 * that was replaced or damaged is never deployed.
 *
 * A save that fails is a warning, never a failed deploy: the Gateway that
 * went live is right either way, and what is lost is only that an app's
 * first deploy from another machine falls back to the older rules.
 */
import type { GatewayNames } from "@every-app/perimeter/manifest";
import { isCfError } from "@/lib/cf/errors";
import { privateTempDir } from "@/lib/cf/privateDir";
import {
  createR2Bucket,
  deleteR2Object,
  getR2Object,
  listR2Objects,
  putR2Object,
  type R2Object,
} from "@/lib/cf/r2";
import type { CfRunner } from "@/lib/cf/runner";
import { CancelledError, errorMessage } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import path from "node:path";
import { RELEASE_TARBALL, type GatewayRelease } from "./release";

/** How many saved releases stay besides the live one. */
const KEPT_BESIDES_LIVE = 2;

/** A saved release's key: only these are ever read or removed. */
const RELEASE_KEY = /^[0-9a-f]{64}\.tar\.gz$/;

/** The object a release of this SHA-256 is saved as. */
export function releaseKey(sha256: string): string {
  return `${sha256}.tar.gz`;
}

/** The saved releases; null when the bucket isn't there yet. */
async function savedReleases(cf: CfRunner, names: GatewayNames): Promise<R2Object[] | null> {
  try {
    return (await listR2Objects(cf, names.releases)).filter((object) => RELEASE_KEY.test(object.key));
  } catch (error) {
    if (isCfError(error, "not_found")) return null;
    throw error;
  }
}

/**
 * Whether the release of this SHA-256 is saved. A listing Cloudflare
 * wouldn't answer (R2 off, a token without R2's permission) counts as not
 * saved: the caller has other ways to the release.
 */
export async function isReleaseSaved(cf: CfRunner, names: GatewayNames, sha256: string): Promise<boolean> {
  try {
    const saved = await savedReleases(cf, names);
    return saved?.some((object) => object.key === releaseKey(sha256)) ?? false;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return false;
  }
}

/**
 * Download the saved release of this SHA-256 into a private directory;
 * null when it can't be had. The caller opens and checks it.
 */
export async function fetchSavedRelease(
  cf: CfRunner,
  names: GatewayNames,
  sha256: string,
): Promise<{ tarball: string; cleanup: () => Promise<void> } | null> {
  const { dir, cleanup } = await privateTempDir("gateway-saved-");
  const tarball = path.join(dir, RELEASE_TARBALL);
  try {
    await getR2Object(cf, names.releases, releaseKey(sha256), tarball);
    return { tarball, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof CancelledError) throw error;
    return null;
  }
}

/** The saved releases after a save, for {@link pruneSavedReleases}. */
type SavedReleases = readonly R2Object[];

/**
 * Save `release` unless it is saved already, creating the bucket on the
 * first save. Returns what is saved now, or null (after a warning) when it
 * couldn't be saved.
 */
export async function saveRelease({
  cf,
  names,
  out,
  release,
}: {
  cf: CfRunner;
  names: GatewayNames;
  out: EventSink;
  release: Pick<GatewayRelease, "tarball" | "manifest">;
}): Promise<SavedReleases | null> {
  const key = releaseKey(release.manifest.sha256);
  try {
    let saved = await savedReleases(cf, names);
    if (saved === null) {
      try {
        await createR2Bucket(cf, names.releases);
      } catch (error) {
        // Another run's first save made it meanwhile.
        if (!isCfError(error, "already_exists")) throw error;
      }
      saved = [];
    }
    const already = saved.some((object) => object.key === key);
    if (!already) {
      await putR2Object(cf, names.releases, key, release.tarball);
      saved = [...saved, { key, lastModified: Date.now() }];
    }
    if (!already) {
      out.emit({
        type: "step",
        step: "gateway.release.save",
        status: "ok",
        message: `Saved Gateway ${release.manifest.version} to R2 (${names.releases})`,
        data: { bucket: names.releases, key },
      });
    }
    return saved;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    out.emit({
      type: "warning",
      code: "GATEWAY_RELEASE_NOT_SAVED",
      message: `Couldn't save this Gateway release to R2: ${errorMessage(error).split("\n")[0] ?? ""}\nThe Gateway is fine. Until the release is saved, a new app's first deploy needs a machine that has this build.`,
      data: {
        bucket: names.releases,
        key,
        rerun: `${CLI} update`,
        rerunNote: "to try again",
      },
    });
    return null;
  }
}

/**
 * Save the live release when it isn't saved yet, for a Gateway that is
 * already up to date (`update` and `setup` with nothing to deploy): one
 * last updated by an everyapp from before releases were saved, or whose
 * save failed. Only the release the install row names is saved as it: a
 * build of the same sources made on this machine is other bytes, and
 * `update --redeploy` deploys and saves that one instead.
 */
export async function ensureLiveReleaseSaved({
  cf,
  names,
  out,
  liveSha256,
  openRelease,
}: {
  cf: CfRunner;
  names: GatewayNames;
  out: EventSink;
  /** The install row's `releaseSha256`. */
  liveSha256: string;
  /** The release this run would deploy: the live one's sources. */
  openRelease: () => Promise<GatewayRelease>;
}): Promise<void> {
  if (await isReleaseSaved(cf, names, liveSha256)) return;
  let release: GatewayRelease;
  try {
    release = await openRelease();
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    out.emit({
      type: "warning",
      code: "GATEWAY_RELEASE_NOT_SAVED",
      message: `Couldn't save the live Gateway release to R2: ${errorMessage(error).split("\n")[0] ?? ""}\nThe Gateway is fine. Until the release is saved, a new app's first deploy needs a machine that has this build.`,
      data: { bucket: names.releases, key: releaseKey(liveSha256), rerun: `${CLI} update`, rerunNote: "to try again" },
    });
    return;
  }
  try {
    if (release.manifest.sha256 !== liveSha256) {
      out.emit({
        type: "warning",
        code: "GATEWAY_RELEASE_NOT_SAVED",
        message: `The live Gateway release isn't saved in R2 yet, and this machine's build of it isn't the one that is live\nThe Gateway is fine. Until a release is saved, a new app's first deploy needs the machine that last updated the Gateway.`,
        data: {
          bucket: names.releases,
          key: releaseKey(liveSha256),
          rerun: `${CLI} update --redeploy`,
          rerunNote: "deploys this machine's build of the same Gateway and saves it",
        },
      });
      return;
    }
    await saveRelease({ cf, names, out, release });
  } finally {
    await release.cleanup();
  }
}

/**
 * Remove every saved release but the live one and the
 * {@link KEPT_BESIDES_LIVE} saved most recently besides, so the bucket
 * never grows. One that can't be removed stays for the next deploy.
 */
export async function pruneSavedReleases({
  cf,
  names,
  saved,
  liveSha256,
}: {
  cf: CfRunner;
  names: GatewayNames;
  saved: SavedReleases;
  liveSha256: string;
}): Promise<string[]> {
  const live = releaseKey(liveSha256);
  const extra = saved
    .filter((object) => object.key !== live)
    .sort((a, b) => b.lastModified - a.lastModified || a.key.localeCompare(b.key))
    .slice(KEPT_BESIDES_LIVE);
  const removed: string[] = [];
  for (const object of extra) {
    try {
      await deleteR2Object(cf, names.releases, object.key);
      removed.push(object.key);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
    }
  }
  return removed;
}

/**
 * Empty the bucket of its saved releases, for the teardown: R2 refuses to
 * delete a bucket with objects. Anything else in it stays, and so then
 * does the bucket.
 */
export async function removeSavedReleases(cf: CfRunner, names: GatewayNames): Promise<void> {
  for (const object of (await savedReleases(cf, names)) ?? []) {
    await deleteR2Object(cf, names.releases, object.key);
  }
}
