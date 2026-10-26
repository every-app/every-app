/**
 * The Gateway an app command's rebind deploys (`deploy` binding a new
 * app or hostname, `delete`): the release that is live, taken again
 * from where the install row says it came (./install.ts `releaseOrigin`),
 * so that deploying or deleting an app never changes the Gateway's code.
 * `update` (and `setup`) is the only verb that does.
 *
 * Where the live release is had again:
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
 * When it can't be (a row from before origins were recorded, a file that
 * is gone, a build cache without that tree, a published-release CLI
 * facing a checkout-built Gateway, a tag that is gone or whose asset was
 * replaced), the rebind refuses before anything changes:
 * GATEWAY_RELEASE_UNAVAILABLE, whose way on is `everyapp update` (which
 * deploys what setup would, ./source.ts, under the downgrade guard), then
 * the same command. Cloudflare's own settings PATCH would bind an app
 * without any upload, but cf has no command for it and a `cf auth login`
 * session gives everyapp no API token of its own.
 */
import fs from "node:fs";
import path from "node:path";
import { findCheckoutRoot } from "@/lib/checkout";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import type { EventSink } from "@/lib/output/events";
import { downloadRelease, fetchGithubReleaseAsset } from "@/lib/release/github";
import { hashCheckoutTree, openCheckoutGatewayRelease, releaseCacheDir } from "./checkoutRelease";
import type { InstallRecord } from "./install";
import {
  describeOrigin,
  openRelease,
  RELEASE_TARBALL,
  type CandidateRelease,
  type GatewayRelease,
  type ReleaseOrigin,
} from "./release";
import { gatewayReleaseSource, type GatewayReleaseSource } from "./source";

type LiveInstall = Pick<
  InstallRecord,
  "releaseVersion" | "releaseSha256" | "releaseOrder" | "sourceTreeSha256" | "releaseOrigin"
>;

export function liveGatewaySource({
  install,
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
  let how: Promise<"fetch" | "cache" | "build" | null> | null = null;
  const obtainable = () =>
    (how ??= (async () => {
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

  const said = (release: GatewayRelease): GatewayRelease => {
    out.emit({
      type: "step",
      step: "gateway.release",
      status: "ok",
      message: `Using the live Gateway ${release.manifest.version} from ${describeOrigin(origin)}`,
      data: { release: release.manifest.version, origin, sha256: release.manifest.sha256, live: true },
    });
    return release;
  };

  const openLive = async (way: "fetch" | "cache" | "build"): Promise<GatewayRelease> => {
    if (way === "build") {
      const release = await buildCheckout(root!);
      // Sources changed while it built: not the live tree any more.
      if (release.source.treeSha256 !== tree) {
        await release.cleanup();
        throw unavailable(install, origin, "this checkout's Gateway sources changed while it built");
      }
      return said(release);
    }
    let tarball: string;
    try {
      ({ tarball } = await fetchLive());
    } catch (error) {
      if (isNotFound(error)) throw unavailable(install, origin, `${describeOrigin(origin)} can't be downloaded any more`);
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
      throw unavailable(install, origin, `the release at ${describeOrigin(origin)} isn't the live one any more (its SHA-256 changed)`);
    }
    return said(release);
  };

  return {
    async describe() {
      if (!(await obtainable())) throw unavailable(install, origin, notObtainable(install, root));
      return live;
    },
    async open() {
      const way = await obtainable();
      if (!way) throw unavailable(install, origin, notObtainable(install, root));
      return openLive(way);
    },
  };
}

/**
 * The live Gateway's release can't be had again, so an app command can't
 * rebind it without changing its code: `update` first, which may.
 */
function unavailable(install: LiveInstall, origin: ReleaseOrigin, why: string): EveryAppError {
  return new EveryAppError(
    "GATEWAY_RELEASE_UNAVAILABLE",
    `The live Gateway ${install.releaseVersion} (from ${describeOrigin(origin)}) can't be fetched again: ${why}\nDeploying or deleting an app never changes the Gateway's code, so nothing has changed. Update the Gateway first.`,
    {
      rerun: `${CLI} update`,
      rerunNote: "then run this again",
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
