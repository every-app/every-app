/**
 * GitHub's release downloads, as an anonymous client sees them:
 * `/releases/latest/download/<asset>` redirects to
 * `/releases/download/<tag>/<asset>`, which redirects to a signed URL on
 * the release-assets host, which serves the file. Anything else is a 404,
 * as GitHub answers for a private repository.
 */
import fs from "node:fs";

interface FakeRelease {
  tag: string;
  /** Asset name → the file it serves. */
  assets: Record<string, string>;
}

export function fakeGithubReleases(
  /** `owner/repo` → its latest release, then older ones. */
  repos: Record<string, FakeRelease[]>,
): { fetch: typeof fetch; requests: Array<{ url: string; init?: RequestInit }> } {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const redirect = (location: string) =>
    new Response(null, { status: 302, headers: { location } });
  const notFound = () => new Response("Not Found", { status: 404 });
  const fakeFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url: url.href, init });
    if (url.hostname === "github.com") {
      const [owner, repo, releases, ...rest] = url.pathname.split("/").filter(Boolean);
      const known = repos[`${owner}/${repo}`];
      if (!known || releases !== "releases") return notFound();
      if (rest[0] === "latest" && rest[1] === "download" && rest.length === 3) {
        const latest = known[0];
        return latest?.assets[rest[2]!]
          ? redirect(`https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(latest.tag)}/${rest[2]}`)
          : notFound();
      }
      if (rest[0] === "download" && rest.length === 3) {
        const release = known.find((candidate) => candidate.tag === decodeURIComponent(rest[1]!));
        return release?.assets[rest[2]!]
          ? redirect(`https://release-assets.githubusercontent.com/${owner}/${repo}/${rest[1]}/${rest[2]}?sig=signed`)
          : notFound();
      }
      return notFound();
    }
    if (url.hostname === "release-assets.githubusercontent.com") {
      const [owner, repo, tag, asset] = url.pathname.split("/").filter(Boolean);
      const file = repos[`${owner}/${repo}`]
        ?.find((candidate) => candidate.tag === decodeURIComponent(tag!))
        ?.assets[asset!];
      if (!file) return notFound();
      const body = fs.readFileSync(file);
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(body.byteLength) },
      });
    }
    throw new TypeError(`fetch failed: tests don't reach the network (${url.origin})`);
  }) as typeof fetch;
  return { fetch: fakeFetch, requests };
}
