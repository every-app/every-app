/**
 * Where the Gateway's code comes from, for every Gateway deploy: `setup`,
 * and the rebind an app's deploy, register or delete runs. One place
 * decides, in this order:
 *
 *  1. `setup --release <url|file>`: that release. A github.com repository
 *     URL means its latest release (`/releases/tag/<tag>`: that one), any
 *     other HTTPS URL a tarball to download, anything else a local file.
 *  2. everyapp runs from a checkout: the release that checkout builds
 *     (./checkoutRelease.ts, its build cache included).
 *  3. Otherwise: the latest release of {@link GATEWAY_RELEASE_REPO}.
 *
 * A release that didn't come from a checkout has no tree hash; the
 * downgrade guard orders it by its release.json (./release.ts
 * `releaseOrder`). A download is made once per run, however often the
 * release is opened, and deleted when everyapp exits.
 */
import fs from "node:fs";
import path from "node:path";
import { findCheckoutRoot } from "@/lib/checkout";
import type { EventSink } from "@/lib/output/events";
import { fetchReleaseTarball } from "@/lib/release/fetch";
import { candidate, type CandidateRelease } from "./apply";
import { checkoutSource, openCheckoutGatewayRelease } from "./checkoutRelease";
import {
  describeOrigin,
  GATEWAY_RELEASE_REPO,
  openRelease,
  RELEASE_TARBALL,
  type GatewayRelease,
  type ReleaseOrigin,
} from "./release";

interface GatewayReleaseSource {
  /**
   * What the Gateway would be, for the downgrade guard: from a checkout
   * without building anything; a release is fetched for it (and kept for
   * {@link open}).
   */
  describe(): Promise<CandidateRelease>;
  /** The release to deploy, opened and checked; the caller cleans it up. */
  open(): Promise<GatewayRelease>;
}

export function gatewayReleaseSource({
  release,
  out,
  verbose,
  checkoutRoot = findCheckoutRoot,
  fetch: fetchImpl,
}: {
  /** `setup --release`: a GitHub repository URL, a tarball's URL or a file. */
  release?: string;
  out: EventSink;
  /** Stream a checkout build's output to stderr too. */
  verbose?: boolean;
  /** The checkout everyapp runs from, if any (tests say none). */
  checkoutRoot?: () => string | null;
  fetch?: typeof fetch;
}): GatewayReleaseSource {
  if (!release) {
    const root = checkoutRoot();
    if (root) {
      return {
        describe: () => checkoutSource(root),
        open: () => openCheckoutGatewayRelease({ root, out, verbose }),
      };
    }
  }
  const target = release ?? GATEWAY_RELEASE_REPO;
  let fetched: Promise<{ tarball: string; origin: ReleaseOrigin }> | null = null;
  let announced = false;
  const fetchOnce = () => (fetched ??= fetchRelease(target, out, fetchImpl));
  const open = async () => {
    const { tarball, origin } = await fetchOnce();
    const opened = await openRelease(tarball, { origin });
    if (!announced) {
      announced = true;
      out.emit({
        type: "step",
        step: "gateway.release",
        status: "ok",
        message: `Using Gateway ${opened.manifest.version} from ${describeOrigin(origin)}.`,
        data: { release: opened.manifest.version, origin, sha256: opened.manifest.sha256 },
      });
    }
    return opened;
  };
  return {
    open,
    async describe() {
      const opened = await open();
      try {
        return candidate(opened);
      } finally {
        await opened.cleanup();
      }
    },
  };
}

/** The tarball `target` names, downloaded when it is a URL. */
async function fetchRelease(
  target: string,
  out: EventSink,
  fetchImpl?: typeof fetch,
): Promise<{ tarball: string; origin: ReleaseOrigin }> {
  const { tarball, origin } = await fetchReleaseTarball(target, {
    asset: RELEASE_TARBALL,
    what: "the Gateway",
    step: "gateway.release",
    missing: `${target} is neither a URL nor a file: pass --release a GitHub repository, a release tarball's URL, or a downloaded ${RELEASE_TARBALL}.`,
    out,
    fetch: fetchImpl,
  });
  // Opened again for every deploy of this run; gone once it exits.
  if (origin.kind !== "file") {
    process.once("exit", () => fs.rmSync(path.dirname(tarball), { recursive: true, force: true }));
  }
  return { tarball, origin };
}
