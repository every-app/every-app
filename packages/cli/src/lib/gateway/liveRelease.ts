/**
 * The Gateway an app command's rebind deploys (`deploy` binding a new
 * app or hostname, `delete`): the release that is live, taken again
 * from where the install row says it came (./install.ts `releaseOrigin`),
 * so that deploying or deleting an app never changes the Gateway's code.
 * `update` (and `setup`) is the only verb that does.
 *
 * Where the live release is had again:
 *
 *  - first, wherever it came from: the copy the Gateway's own Cloudflare
 *    account keeps in R2 (./releaseStore.ts), which every `update` and
 *    `setup` saves under the row's SHA-256, so any machine logged in to
 *    the account has the exact release that is live. Opened and checked
 *    like any release, and never used unless its SHA-256 is the row's;
 *
 * and when R2 has none (a Gateway last updated by an everyapp from before
 * releases were saved, or a save that failed), as before:
 *
 *  - a GitHub release: that tag, downloaded and checked against the row's
 *    SHA-256 once opened;
 *  - a tarball's URL: downloaded again, checked the same way; a file: the
 *    file, when it is there;
 *  - a checkout's build: this checkout's build cache for the row's tree
 *    hash (./checkoutRelease.ts keeps the last few builds by tree), or a
 *    new build when this checkout's Gateway sources hash to that tree (an
 *    untagged Gateway such as one deployed from main: the same sources
 *    are no upgrade). A row from before origins were recorded counts as a
 *    checkout's.
 *
 * When it can't be (no copy in R2, and: a row from before origins were recorded, a file that
 * is gone, a build cache without that tree, a published-release CLI
 * facing a checkout-built Gateway, a tag that is gone or whose asset was
 * replaced), the rebind refuses before anything changes:
 * GATEWAY_RELEASE_UNAVAILABLE, whose way on is `everyapp update` (which
 * deploys what setup would, ./source.ts, under the downgrade guard, and
 * saves it to R2: once, from a machine that can), then the same command. Cloudflare's own settings PATCH would bind an app
 * without any upload, but cf has no command for it and a `cf auth login`
 * session gives everyapp no API token of its own.
 */
import fs from "node:fs";
import path from "node:path";
import type { GatewayNames } from "@every-app/perimeter/manifest";
import type { CfRunner } from "@/lib/cf/runner";
import { findCheckoutRoot } from "@/lib/checkout";
import { CancelledError, EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { downloadRelease, fetchGithubReleaseAsset } from "@/lib/release/github";
import { hashCheckoutTree, openCheckoutGatewayRelease, releaseCacheDir } from "./checkoutRelease";
import type { InstallRecord } from "./install";
import { fetchSavedRelease, isReleaseSaved } from "./releaseStore";
import {
  describeOrigin,
  openRelease,
  RELEASE_TARBALL,
  type CandidateRelease,
  type GatewayRelease,
  type ReleaseOrigin,
} from "./release";
import { gatewayReleaseSource, type GatewayReleaseSource } from "./source";

/** How the live release is had again: its saved copy in R2, or one of the older ways. */
type Way = "saved" | "fetch" | "cache" | "build";

type LiveInstall = Pick<
  InstallRecord,
  "releaseVersion" | "releaseSha256" | "releaseOrder" | "sourceTreeSha256" | "releaseOrigin"
>;

export function liveGatewaySource({
  install,
  store,
  out,
  verbose,
  cliVersion,
  checkoutRoot = findCheckoutRoot,
  fetch: fetchImpl,
  checkoutTree = hashCheckoutTree,
  buildCheckout = (root) => openCheckoutGatewayRelease({ root, out, verbose }),
}: {
  /** The install row; null before any Gateway is installed (then setup's source). */
  install: LiveInstall | null;
  /**
   * The Gateway's account and names, to look for the live release in its
   * R2 bucket first (./releaseStore.ts); without them, only the older ways.
   */
  store?: { cf: CfRunner; names: GatewayNames };
  out: EventSink;
  verbose?: boolean;
  cliVersion: string;
  checkoutRoot?: () => string | null;
  fetch?: typeof fetch;
  /** The tree hash of a checkout's Gateway sources (tests). */
  checkoutTree?: (root: string) => Promise<string | null>;
  /** The Gateway a checkout builds (tests). */
  buildCheckout?: (root: string) => Promise<GatewayRelease>;
}): GatewayReleaseSource {
  if (!install) return gatewayReleaseSource({ out, verbose, cliVersion, checkoutRoot, fetch: fetchImpl });
  const root = checkoutRoot();
  const origin = install.releaseOrigin ?? { kind: "checkout" };
  /** The live release, as the downgrade guard sees it: never older than itself. */
  const live: CandidateRelease = {
    version: install.releaseVersion,
    sha256: install.releaseSha256,
    order: install.releaseOrder,
    treeSha256: install.sourceTreeSha256,
    origin,
  };
  const cached =
    origin.kind === "checkout" && root && install.sourceTreeSha256
      ? path.join(releaseCacheDir(root), `${install.sourceTreeSha256}.tar.gz`)
      : null;

  const tree = install.sourceTreeSha256;
  /**
   * How the live release can be had again, told without fetching; null
   * when it can't. A checkout's Gateway comes from the build cache for the
   * row's tree hash, or is built again when this checkout's sources hash
   * to it: builds aren't byte-reproducible, so the tree is what is live
   * (./apply.ts `isLiveRelease` says the same), and that build is no upgrade.
   */
  let how: Promise<Way | null> | null = null;
  const obtainable = () =>
    (how ??= (async () => {
      if (store && (await isReleaseSaved(store.cf, store.names, install.releaseSha256))) return "saved";
      return obtainableElsewhere();
    })());
  /** The ways from before releases were saved. */
  let elsewhere: Promise<Exclude<Way, "saved"> | null> | null = null;
  const obtainableElsewhere = () =>
    (elsewhere ??= (async () => {
      switch (origin.kind) {
        case "github":
        case "url":
          return "fetch";
        case "file":
          return fs.existsSync(origin.path) ? "fetch" : null;
        case "checkout":
          if (cached !== null && fs.existsSync(cached)) return "cache";
          return root && tree && (await checkoutTree(root)) === tree ? "build" : null;
      }
    })());

  let fetched: Promise<{ tarball: string; cleanup: () => Promise<void> }> | null = null;
  const fetchLive = () =>
    (fetched ??= (async () => {
      switch (origin.kind) {
        case "github": {
          const download = await fetchGithubReleaseAsset({
            repo: origin.repo,
            asset: RELEASE_TARBALL,
            tag: origin.tag,
            fetch: fetchImpl,
          });
          process.once("exit", () =>
            fs.rmSync(path.dirname(download.tarball), { recursive: true, force: true }),
          );
          return download;
        }
        case "url": {
          const download = await downloadRelease(origin.url, { fetch: fetchImpl });
          process.once("exit", () =>
            fs.rmSync(path.dirname(download.tarball), { recursive: true, force: true }),
          );
          return download;
        }
        case "file":
          return { tarball: origin.path, cleanup: async () => undefined };
        case "checkout":
          return { tarball: cached!, cleanup: async () => undefined };
      }
    })());

  const said = (release: GatewayRelease, saved = false): GatewayRelease => {
    out.emit({
      type: "step",
      step: "gateway.release",
      status: "ok",
      message: `Using the live Gateway ${release.manifest.version} from ${saved ? "its saved copy in R2" : describeOrigin(origin)}`,
      data: { release: release.manifest.version, origin, sha256: release.manifest.sha256, live: true, saved },
    });
    return release;
  };

  /**
   * The saved copy, opened and checked; null when it is gone since it was
   * listed, damaged, or not the release the row names: then the other ways.
   */
  const openSaved = async (): Promise<GatewayRelease | null> => {
    const download = await fetchSavedRelease(store!.cf, store!.names, install.releaseSha256);
    if (!download) return null;
    let release: GatewayRelease;
    try {
      release = await openRelease(download.tarball, {
        origin,
        treeSha256: tree,
        committedAt: install.releaseOrder.committedAt,
      });
    } catch (error) {
      await download.cleanup();
      if (error instanceof CancelledError) throw error;
      return null;
    }
    const cleanup = async () => {
      await release.cleanup();
      await download.cleanup();
    };
    // release.json isn't part of the SHA-256: what the row says of the
    // release stays what the next row says, whatever the object's says.
    if (
      release.manifest.sha256 !== install.releaseSha256 ||
      release.manifest.version !== install.releaseVersion
    ) {
      await cleanup();
      return null;
    }
    return said(
      { ...release, source: { ...release.source, order: install.releaseOrder }, cleanup, saved: true },
      true,
    );
  };

  const openLive = async (way: Way): Promise<GatewayRelease> => {
    if (way === "saved") {
      const release = await openSaved();
      if (release) return release;
      const other = await obtainableElsewhere();
      if (!other) throw unavailable(install, origin, root, notObtainable(install, root));
      return openLive(other);
    }
    if (way === "build") {
      const release = await buildCheckout(root!);
      // Sources changed while it built: not the live tree any more.
      if (release.source.treeSha256 !== tree) {
        await release.cleanup();
        throw unavailable(install, origin, root, "this checkout's Gateway sources changed while it built");
      }
      return said(release);
    }
    let tarball: string;
    try {
      ({ tarball } = await fetchLive());
    } catch (error) {
      if (isNotFound(error)) throw unavailable(install, origin, root, `${describeOrigin(origin)} can't be downloaded any more`);
      throw error;
    }
    if (way === "cache") {
      return said(await openRelease(tarball, { origin, treeSha256: tree, committedAt: install.releaseOrder.committedAt }));
    }
    const release = await openRelease(tarball, { origin });
    // Not the bytes that are live (an asset replaced under its tag): never
    // deployed by an app command, whatever its version.
    if (release.manifest.sha256 !== install.releaseSha256) {
      await release.cleanup();
      throw unavailable(install, origin, root, `the release at ${describeOrigin(origin)} isn't the live one any more (its SHA-256 changed)`);
    }
    return said(release);
  };

  return {
    async describe() {
      if (!(await obtainable())) throw unavailable(install, origin, root, notObtainable(install, root));
      return live;
    },
    async open() {
      const way = await obtainable();
      if (!way) throw unavailable(install, origin, root, notObtainable(install, root));
      return openLive(way);
    },
  };
}

/**
 * The live Gateway's release can't be had again, so an app command can't
 * rebind it without changing its code: `update` first, which may.
 */
function unavailable(install: LiveInstall, origin: ReleaseOrigin, root: string | null, why: string): EveryAppError {
  return new EveryAppError(
    "GATEWAY_RELEASE_UNAVAILABLE",
    `The live Gateway ${install.releaseVersion} (from ${describeOrigin(origin)}) can't be fetched again: ${why}\nDeploying or deleting an app never changes the Gateway's code, so nothing has changed. Update the Gateway first: that also saves its release in its Cloudflare account, so every machine can do this afterwards.`,
    {
      rerun: `${CLI} update`,
      // A checkout's Gateway is updated from a checkout: a published
      // everyapp would deploy its own release instead.
      rerunNote:
        origin.kind === "checkout" && root === null
          ? "from a checkout of the Gateway's repository, then run this again"
          : "then run this again",
      data: { live: install.releaseVersion, origin, why },
    },
  );
}

/** Why the live release can't be had again, for the error that says so. */
function notObtainable(install: LiveInstall, root: string | null): string {
  const origin = install.releaseOrigin;
  if (origin === null) {
    // Installed before the row recorded where Gateways come from.
    return root
      ? "it was installed before everyapp recorded where a Gateway comes from, and this checkout neither holds its build nor has its sources"
      : "it was installed before everyapp recorded where a Gateway comes from";
  }
  switch (origin.kind) {
    case "file":
      return `${origin.path} is gone`;
    case "checkout":
      return root
        ? "this checkout's Gateway sources aren't the live ones, and its build cache doesn't hold that build"
        : "it was built from a checkout, and this everyapp isn't running from one";
    default:
      return "it is out of reach";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "RELEASE_NOT_FOUND"
  );
}
