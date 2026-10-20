/**
 * Release tarballs from the web: a GitHub repository's release asset, or
 * any HTTPS URL. Anonymous only: no token, cookie or header that says who
 * is asking is ever sent, so a private repository's releases are out of
 * reach (GitHub answers 404). The latest release costs no API call:
 * `/releases/latest/download/<asset>` redirects to
 * `/releases/download/<tag>/<asset>`, which names the tag.
 *
 * What comes down lands in the CLI's private temp dir (lib/cf/privateDir.ts),
 * never the shared one, and is checked by whoever opens it
 * (lib/gateway/release.ts `openRelease`).
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { privateTempDir } from "@/lib/cf/privateDir";
import { EveryAppError } from "@/lib/errors";

/** Far above a Gateway release (a few MB), far below a disk's worth. */
const MAX_BYTES = 200 * 1024 * 1024;
const TIMEOUT_MS = 5 * 60_000;
/** github.com, then its release-assets host: two. */
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export interface DownloadedRelease {
  /** The downloaded file, in a private temp dir of its own. */
  tarball: string;
  /** The release's tag, when the URL or its redirects name one. */
  tag: string | null;
  /** The URL it was asked for. */
  url: string;
  /** Delete the download. */
  cleanup(): Promise<void>;
}

interface DownloadOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * `owner/repo` from `https://github.com/<owner>/<repo>[/...]` (`.git` and
 * all) or `owner/repo` itself; null for anything else.
 */
export function parseGithubRepo(input: string): string | null {
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(input.trim());
  if (shorthand) return `${shorthand[1]}/${shorthand[2]!.replace(/\.git$/, "")}`;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return `${owner}/${repo.replace(/\.git$/, "")}`;
}

/**
 * `asset` of `repo`'s release `tag`, or of its latest release. The tag
 * comes from the URL GitHub redirects to.
 */
export async function fetchGithubReleaseAsset({
  repo,
  asset,
  tag,
  ...options
}: {
  /** `owner/repo` or a github.com URL in it. */
  repo: string;
  asset: string;
  tag?: string;
} & DownloadOptions): Promise<DownloadedRelease & { tag: string; repo: string }> {
  const name = parseGithubRepo(repo);
  if (!name) {
    throw new EveryAppError(
      "RELEASE_NOT_FOUND",
      `${repo} isn't a GitHub repository (https://github.com/<owner>/<repo>).`,
    );
  }
  const url = tag
    ? `https://github.com/${name}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
    : `https://github.com/${name}/releases/latest/download/${encodeURIComponent(asset)}`;
  const download = await downloadRelease(url, {
    ...options,
    notFound: `${name} has no ${tag ? `release ${tag}` : "published release"} with ${asset} that can be downloaded without signing in (https://github.com/${name}/releases).`,
  });
  if (!download.tag) {
    await download.cleanup();
    throw new EveryAppError(
      "RELEASE_DOWNLOAD_FAILED",
      `GitHub didn't say which release of ${name} ${url} is.`,
    );
  }
  return { ...download, tag: download.tag, repo: name };
}

/**
 * Download `url` over HTTPS, redirects followed (to HTTPS only), within
 * the size limit and the timeout.
 */
export async function downloadRelease(
  url: string,
  {
    fetch: fetchImpl = fetch,
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    notFound,
  }: DownloadOptions & { notFound?: string } = {},
): Promise<DownloadedRelease> {
  const signal = AbortSignal.timeout(timeoutMs);
  const { response, current, tag } = await follow(url, fetchImpl, signal).catch(
    (error: unknown) => {
      throw downloadError(error, url);
    },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    throw new EveryAppError("RELEASE_NOT_FOUND", notFound ?? `${url} doesn't exist (404).`);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new EveryAppError(
      "RELEASE_DOWNLOAD_FAILED",
      `Couldn't download ${url}: HTTP ${response.status}.`,
      { retryable: response.status >= 500 },
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body.cancel();
    throw tooLarge(url, maxBytes);
  }

  const { dir, cleanup } = await privateTempDir("release-download-");
  const tarball = path.join(dir, path.posix.basename(current.pathname) || "release.tar.gz");
  try {
    const file = await fsp.open(tarball, "wx", 0o600);
    try {
      let bytes = 0;
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) throw tooLarge(url, maxBytes);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    await response.body.cancel().catch(() => undefined);
    await cleanup();
    throw downloadError(error, url);
  }
  return { tarball, tag, url, cleanup };
}

/**
 * Request `url`, following its redirects by hand: each must be HTTPS, and
 * the first that names a GitHub release's tag gives it.
 */
async function follow(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<{ response: Response; current: URL; tag: string | null }> {
  let current = httpsUrl(url, url);
  let tag = githubReleaseTag(current);
  for (let hops = 0; ; hops += 1) {
    const response = await fetchImpl(current.href, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: { accept: "application/octet-stream" },
    });
    if (!REDIRECTS.has(response.status)) return { response, current, tag };
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || hops >= MAX_REDIRECTS) {
      throw new EveryAppError(
        "RELEASE_DOWNLOAD_FAILED",
        `${url} redirects ${location ? "too many times" : "nowhere"}.`,
      );
    }
    current = httpsUrl(new URL(location, current).href, url);
    tag ??= githubReleaseTag(current);
  }
}

/** Only HTTPS, there and on every redirect. */
function httpsUrl(href: string, asked: string): URL {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new EveryAppError("RELEASE_DOWNLOAD_FAILED", `${href} isn't a URL.`);
  }
  if (url.protocol !== "https:") {
    throw new EveryAppError(
      "RELEASE_DOWNLOAD_FAILED",
      `${asked} ${href === asked ? "isn't" : `redirects to ${href}, which isn't`} an HTTPS URL.`,
    );
  }
  return url;
}

/** The tag of a github.com `/<owner>/<repo>/releases/download/<tag>/<asset>` URL. */
function githubReleaseTag(url: URL): string | null {
  if (url.hostname !== "github.com") return null;
  const match = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/[^/]+$/.exec(url.pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function tooLarge(url: string, maxBytes: number): EveryAppError {
  return new EveryAppError(
    "RELEASE_TOO_LARGE",
    `${url} is over ${Math.round(maxBytes / 1024 / 1024)} MB, too big for a release\nA release is a few MB. Check the URL.`,
  );
}

function downloadError(error: unknown, url: string): Error {
  if (error instanceof EveryAppError) return error;
  const name = (error as Error).name;
  return new EveryAppError(
    "RELEASE_DOWNLOAD_FAILED",
    name === "TimeoutError" || name === "AbortError"
      ? `Downloading ${url} timed out.`
      : `Couldn't download ${url}: ${(error as Error).message}`,
    { retryable: true },
  );
}
