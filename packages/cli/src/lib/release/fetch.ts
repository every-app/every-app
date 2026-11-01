/**
 * The tarball a release argument names, for either kind of release: a
 * github.com repository URL (its latest release, or `/releases/tag/<tag>`:
 * that one), any other HTTPS URL a tarball to download, anything else a
 * local file. What it says it came from is the release's origin
 * (lib/gateway/release.ts `ReleaseOrigin`).
 */
import fs from "node:fs";
import path from "node:path";
import { EveryAppError } from "@/lib/errors";
import type { ReleaseOrigin } from "@/lib/gateway/release";
import type { EventSink } from "@/lib/output/events";
import {
  downloadRelease,
  fetchGithubReleaseAsset,
  parseGithubRepo,
  type DownloadedRelease,
} from "./github";

interface ReleaseTarball {
  tarball: string;
  origin: ReleaseOrigin;
  /** Delete a download (nothing for a local file). */
  cleanup(): Promise<void>;
}

/** Whether `target` is a URL rather than a path. */
export function isUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

export async function fetchReleaseTarball(
  target: string,
  {
    asset,
    what,
    step,
    missing,
    out,
    fetch: fetchImpl,
  }: {
    /** The release asset a repository's release carries. */
    asset: string;
    /** What is downloaded, for the progress line: "the Gateway", "the app". */
    what: string;
    step: string;
    /** The message for a path that isn't there. */
    missing: string;
    out: EventSink;
    fetch?: typeof fetch;
  },
): Promise<ReleaseTarball> {
  if (!isUrl(target)) {
    const file = path.resolve(target);
    if (!fs.existsSync(file)) throw new EveryAppError("RELEASE_NOT_FOUND", missing);
    return { tarball: file, origin: { kind: "file", path: file }, cleanup: async () => undefined };
  }
  const repo = githubRepository(target);
  out.emit({
    type: "progress",
    step,
    message: `Downloading ${what} from ${repo ? `${repo.repo}${repo.tag ? ` release ${repo.tag}` : "'s latest release"}` : target}...`,
    data: { url: target },
  });
  let download: DownloadedRelease;
  let origin: ReleaseOrigin;
  if (repo) {
    const github = await fetchGithubReleaseAsset({
      repo: repo.repo,
      asset,
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
  return { tarball: download.tarball, origin, cleanup: download.cleanup };
}

/**
 * A github.com URL of a repository (its latest release) or of one of its
 * releases (`/releases/tag/<tag>`); null for any other URL, a tarball's
 * among them.
 */
export function githubRepository(target: string): { repo: string; tag?: string } | null {
  const repo = parseGithubRepo(target);
  if (!repo || !isUrl(target)) return null;
  const rest = new URL(target).pathname.split("/").filter(Boolean).slice(2);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "releases")) return { repo };
  if (rest.length === 3 && rest[0] === "releases" && rest[1] === "tag") {
    return { repo, tag: decodeURIComponent(rest[2]!) };
  }
  if (rest.length === 2 && rest[0] === "releases" && rest[1] === "latest") return { repo };
  return null;
}
