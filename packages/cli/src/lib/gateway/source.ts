/**
 * Where the Gateway's code comes from, for `setup` and `update` (the
 * rebind an app's deploy or delete runs has its own rule: ./liveRelease.ts).
 * One place decides, in this order:
 *
 *  1. `--release <url|file>`: that release. A github.com repository URL
 *     means its latest release (`/releases/tag/<tag>`: that one), any
 *     other HTTPS URL a tarball to download, anything else a local file.
 *  2. everyapp runs from a checkout (`pnpm everyapp`): the release that
 *     checkout builds (./checkoutRelease.ts, its build cache included).
 *  3. Otherwise, the published release for this CLI's own version: the
 *     GitHub Release of {@link GATEWAY_RELEASE_REPO} tagged
 *     `gateway-v<version>` (the Gateway Release workflow publishes one
 *     with every CLI version), or when there is none yet, the newest
 *     stable one (`/releases/latest`), said so in a warning.
 *
 * A release that didn't come from a checkout has no tree hash; the
 * downgrade guard orders it by its release.json (./release.ts
 * `releaseOrder`). Its SHA-256 is checked when it is opened
 * (./release.ts `extractRelease`). A download is made once per run,
 * however often the release is opened, and deleted when everyapp exits.
 */
import fs from "node:fs";
import path from "node:path";
import { findCheckoutRoot } from "@/lib/checkout";
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import { fetchReleaseTarball, githubRepository, isUrl } from "@/lib/release/fetch";
import { fetchGithubReleaseAsset } from "@/lib/release/github";
import { candidate } from "./apply";
import { checkoutSource, openCheckoutGatewayRelease } from "./checkoutRelease";
import {
  describeOrigin,
  GATEWAY_RELEASE_REPO,
  gatewayReleaseTag,
  openRelease,
  RELEASE_TARBALL,
  type CandidateRelease,
  type GatewayRelease,
  type ReleaseOrigin,
} from "./release";

export interface GatewayReleaseSource {
  /**
   * What the Gateway would be, for the downgrade guard: from a checkout
   * without building anything; a release is fetched for it (and kept for
   * {@link open}).
   */
  describe(): Promise<CandidateRelease>;
  /** The release to deploy, opened and checked; the caller cleans it up. */
  open(): Promise<GatewayRelease>;
}

/** A fetched tarball and where it came from, kept for the run. */
interface FetchedRelease {
  tarball: string;
  origin: ReleaseOrigin;
}

export function gatewayReleaseSource({
  release,
  out,
  verbose,
  cliVersion,
  checkoutRoot = findCheckoutRoot,
  fetch: fetchImpl,
}: {
  /** `--release`: a GitHub repository URL, a tarball's URL or a file. */
  release?: string;
  out: EventSink;
  /** Stream a checkout build's output to stderr too. */
  verbose?: boolean;
  /** This CLI's version: the published release it asks for first. */
  cliVersion: string;
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
  return fetchedSource(
    () =>
      release
        ? fetchNamedRelease(release, out, fetchImpl)
        : fetchPublishedRelease(cliVersion, out, fetchImpl),
    out,
  );
}

/**
 * A source over a tarball fetched once (`fetchOnce`), opened for every
 * deploy of the run; the first open says what it is.
 */
function fetchedSource(
  fetchOnce: () => Promise<FetchedRelease>,
  out: EventSink,
): GatewayReleaseSource {
  let fetched: Promise<FetchedRelease> | null = null;
  let announced = false;
  const open = async () => {
    const { tarball, origin } = await (fetched ??= fetchOnce());
    const opened = await openRelease(tarball, { origin });
    if (!announced) {
      announced = true;
      out.emit({
        type: "step",
        step: "gateway.release",
        status: "ok",
        message: `Using Gateway ${opened.manifest.version} from ${describeOrigin(origin)}`,
        data: {
          release: opened.manifest.version,
          origin,
          sha256: opened.manifest.sha256,
          downloaded: origin.kind !== "file",
        },
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

/** The tarball `--release` names, downloaded when it is a URL. */
async function fetchNamedRelease(
  target: string,
  out: EventSink,
  fetchImpl?: typeof fetch,
): Promise<FetchedRelease> {
  if (isUrl(target)) {
    const repo = githubRepository(target);
    out.emit({
      type: "step",
      step: "gateway.release",
      status: "start",
      message:
        repo && !repo.tag
          ? "Downloading the latest Gateway release..."
          : `Downloading the Gateway release${repo?.tag ? ` ${repo.tag}` : ""}...`,
      data: { url: target },
    });
  }
  const { tarball, origin } = await fetchReleaseTarball(target, {
    asset: RELEASE_TARBALL,
    what: "the Gateway",
    step: "gateway.release",
    missing: `${target} doesn't exist\n--release takes a GitHub repository, a release tarball's URL, or a downloaded ${RELEASE_TARBALL}. Check the path, or leave out --release for the published release.`,
    out,
    fetch: fetchImpl,
  });
  return keptForRun({ tarball, origin });
}

/**
 * The published release for this CLI's version (`gateway-v<version>` of
 * {@link GATEWAY_RELEASE_REPO}), or with none yet, the newest stable one,
 * said so. Neither: the error says what to do.
 */
async function fetchPublishedRelease(
  cliVersion: string,
  out: EventSink,
  fetchImpl?: typeof fetch,
): Promise<FetchedRelease> {
  const tag = gatewayReleaseTag(cliVersion);
  out.emit({
    type: "step",
    step: "gateway.release",
    status: "start",
    message: `Downloading the Gateway release ${tag}...`,
    data: { repo: GATEWAY_RELEASE_REPO, tag },
  });
  const exact = await fetchGithubReleaseAsset({
    repo: GATEWAY_RELEASE_REPO,
    asset: RELEASE_TARBALL,
    tag,
    fetch: fetchImpl,
  }).catch((error: unknown) => {
    if (error instanceof EveryAppError && error.code === "RELEASE_NOT_FOUND") return null;
    throw error;
  });
  if (exact) return keptForRun({ tarball: exact.tarball, origin: github(exact) });

  out.emit({
    type: "warning",
    code: "GATEWAY_RELEASE_LATEST",
    step: "gateway.release",
    message: `There is no Gateway release for everyapp ${cliVersion} yet (${GATEWAY_RELEASE_REPO} has no ${tag})\nUsing the latest stable Gateway release instead. To take another: --release <url|file>.`,
    data: { cliVersion, tag, repo: GATEWAY_RELEASE_REPO },
  });
  let latest: Awaited<ReturnType<typeof fetchGithubReleaseAsset>>;
  try {
    latest = await fetchGithubReleaseAsset({
      repo: GATEWAY_RELEASE_REPO,
      asset: RELEASE_TARBALL,
      fetch: fetchImpl,
    });
  } catch (error) {
    if (!(error instanceof EveryAppError) || error.code !== "RELEASE_NOT_FOUND") throw error;
    throw new EveryAppError(
      "RELEASE_NOT_FOUND",
      `${GATEWAY_RELEASE_REPO} has no Gateway release everyapp ${cliVersion} can install\nNeither ${tag} nor a latest release with ${RELEASE_TARBALL} can be downloaded without signing in.`,
      {
        fix: `pass --release <url|file> (a Gateway release you have), or run everyapp from a checkout (pnpm everyapp), which builds the Gateway`,
        data: { repo: GATEWAY_RELEASE_REPO, tag, cliVersion },
      },
    );
  }
  return keptForRun({ tarball: latest.tarball, origin: github(latest) });
}

function github({ repo, tag }: { repo: string; tag: string }): ReleaseOrigin {
  return { kind: "github", repo, tag };
}

/** A download is opened again for every deploy of the run, and gone once it exits. */
function keptForRun(release: FetchedRelease): FetchedRelease {
  if (release.origin.kind !== "file") {
    process.once("exit", () =>
      fs.rmSync(path.dirname(release.tarball), { recursive: true, force: true }),
    );
  }
  return release;
}
