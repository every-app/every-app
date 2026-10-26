/**
 * The Gateway an app command's rebind deploys (`deploy` binding a new
 * app or hostname, `delete`): the release that is live, taken again
 * from where the install row says it came (./install.ts `releaseOrigin`),
 * so that deploying an app never changes the Gateway's code on the way.
 * `update` is the verb for that.
 *
 * Where the live release is had again:
 *
 *  - a GitHub release: that tag, downloaded (checked against the row's
 *    SHA-256 once opened; a tag whose asset was replaced is said so);
 *  - a tarball's URL: downloaded again; a file: the file, when it is there;
 *  - a checkout's build: this checkout's build cache for the row's tree
 *    hash (./checkoutRelease.ts keeps the last few builds by tree).
 *
 * When it can't be (a row from before origins were recorded, a file that
 * is gone, a build cache without that tree, a published-release CLI
 * facing a checkout-built Gateway), the rebind deploys what `setup` would
 * (./source.ts: this checkout's build, or the published release for this
 * everyapp), said so, and the downgrade guard orders it as ever
 * (./apply.ts `olderThanInstalled`): a rebind can upgrade the Gateway,
 * never silently and never downgrade it.
 */
import fs from "node:fs";
import path from "node:path";
import { findCheckoutRoot } from "@/lib/checkout";
import type { EventSink } from "@/lib/output/events";
import { downloadRelease, fetchGithubReleaseAsset } from "@/lib/release/github";
import { releaseCacheDir } from "./checkoutRelease";
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
}: {
  /** The install row; null before any Gateway is installed (then setup's source). */
  install: LiveInstall | null;
  out: EventSink;
  verbose?: boolean;
  cliVersion: string;
  checkoutRoot?: () => string | null;
  fetch?: typeof fetch;
}): GatewayReleaseSource {
  const fallback = gatewayReleaseSource({ out, verbose, cliVersion, checkoutRoot, fetch: fetchImpl });
  if (!install) return fallback;
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

  /** Whether the live release can be had again, told without fetching. */
  const obtainable = (): boolean => {
    switch (origin.kind) {
      case "github":
      case "url":
        return true;
      case "file":
        return fs.existsSync(origin.path);
      case "checkout":
        return cached !== null && fs.existsSync(cached);
    }
  };

  let saidFallback = false;
  const useFallback = (why: string) => {
    if (!saidFallback) {
      saidFallback = true;
      out.emit({
        type: "step",
        step: "gateway.release",
        status: "start",
        message: `The live Gateway ${install.releaseVersion} (from ${describeOrigin(origin)}) can't be taken again: ${why}. Deploying ${root ? "this checkout's Gateway" : "the published release for this everyapp"} instead.`,
        data: { live: install.releaseVersion, origin, why },
      });
    }
    return fallback;
  };

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

  const openLive = async (): Promise<GatewayRelease> => {
    const { tarball } = await fetchLive();
    const from: Parameters<typeof openRelease>[1] =
      origin.kind === "checkout"
        ? { origin, treeSha256: install.sourceTreeSha256, committedAt: install.releaseOrder.committedAt }
        : { origin };
    const release = await openRelease(tarball, from);
    if (release.manifest.sha256 !== install.releaseSha256) {
      // Not the bytes that are live (an asset replaced under its tag): the
      // downgrade guard orders it as any other release.
      out.emit({
        type: "warning",
        code: "GATEWAY_RELEASE_DIFFERS",
        step: "gateway.release",
        message: `The Gateway release at ${describeOrigin(origin)} isn't the one that is live any more (its SHA-256 changed)\nDeploying it as an update; a Gateway older than the live one is refused.`,
        data: { origin, live: install.releaseSha256, found: release.manifest.sha256 },
      });
    } else {
      out.emit({
        type: "step",
        step: "gateway.release",
        status: "ok",
        message: `Using the live Gateway ${release.manifest.version} from ${describeOrigin(origin)}`,
        data: { release: release.manifest.version, origin, sha256: release.manifest.sha256, live: true },
      });
    }
    return release;
  };

  return {
    async describe() {
      return obtainable() ? live : useFallback(notObtainable(origin, root)).describe();
    },
    async open() {
      if (!obtainable()) return useFallback(notObtainable(origin, root)).open();
      try {
        return await openLive();
      } catch (error) {
        // A tag or URL gone since the install: what setup would deploy.
        if (isNotFound(error)) return useFallback(`${describeOrigin(origin)} can't be downloaded any more`).open();
        throw error;
      }
    },
  };
}

/** Why the live release can't be had again, for the line that says so. */
function notObtainable(origin: ReleaseOrigin, root: string | null): string {
  switch (origin.kind) {
    case "file":
      return `${origin.path} is gone`;
    case "checkout":
      return root
        ? "this checkout hasn't built that tree (its build cache keeps the last few builds)"
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
