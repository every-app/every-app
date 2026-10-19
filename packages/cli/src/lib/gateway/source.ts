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
import { EveryAppError } from "@/lib/errors";
import type { EventSink } from "@/lib/output/events";
import {
  downloadRelease,
  fetchGithubReleaseAsset,
  parseGithubRepo,
  type DownloadedRelease,
} from "@/lib/release/github";
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
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    const file = path.resolve(target);
    if (!fs.existsSync(file)) {
      throw new EveryAppError(
        "RELEASE_NOT_FOUND",
        `${target} is neither a URL nor a file: pass --release a GitHub repository, a release tarball's URL, or a downloaded ${RELEASE_TARBALL}.`,
      );
    }
    return { tarball: file, origin: { kind: "file", path: file } };
  }
  const repo = githubRepository(target);
  out.emit({
    type: "progress",
    step: "gateway.release",
    message: `Downloading the Gateway from ${repo ? `${repo.repo}${repo.tag ? ` release ${repo.tag}` : "'s latest release"}` : target}...`,
    data: { url: target },
  });
  let download: DownloadedRelease;
  let origin: ReleaseOrigin;
  if (repo) {
    const github = await fetchGithubReleaseAsset({
      repo: repo.repo,
      asset: RELEASE_TARBALL,
      tag: repo.tag,
      fetch: fetchImpl,
    });
    download = github;
    origin = { kind: "github", repo: github.repo, tag: github.tag };
  } else {
    download = await downloadRelease(target, { fetch: fetchImpl });
    const named = download.tag ? parseGithubRepo(target) : null;
    origin =
      named && download.tag
        ? { kind: "github", repo: named, tag: download.tag }
        : { kind: "url", url: target };
  }
  // Opened again for every deploy of this run; gone once it exits.
  process.once("exit", () => fs.rmSync(path.dirname(download.tarball), { recursive: true, force: true }));
  return { tarball: download.tarball, origin };
}

/**
 * A github.com URL of a repository (its latest release) or of one of its
 * releases (`/releases/tag/<tag>`); null for any other URL, a tarball's
 * among them.
 */
function githubRepository(target: string): { repo: string; tag?: string } | null {
  const repo = parseGithubRepo(target);
  if (!repo) return null;
  const rest = new URL(target).pathname.split("/").filter(Boolean).slice(2);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "releases")) return { repo };
  if (rest.length === 3 && rest[0] === "releases" && rest[1] === "tag") {
    return { repo, tag: decodeURIComponent(rest[2]!) };
  }
  if (rest.length === 2 && rest[0] === "releases" && rest[1] === "latest") return { repo };
  return null;
}
