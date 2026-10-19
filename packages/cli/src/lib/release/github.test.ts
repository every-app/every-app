import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { downloadRelease, fetchGithubReleaseAsset, parseGithubRepo } from "./github";

const ASSET = "every-app-gateway-release.tar.gz";
let work: string;
let file: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "github-release-"));
  file = path.join(work, ASSET);
  fs.writeFileSync(file, "a release");
});

afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

describe("parseGithubRepo", () => {
  it("reads owner/repo from a github.com URL or the shorthand", () => {
    expect(parseGithubRepo("https://github.com/every-app/every-app")).toBe("every-app/every-app");
    expect(parseGithubRepo("https://github.com/every-app/every-app.git")).toBe("every-app/every-app");
    expect(parseGithubRepo("https://github.com/every-app/every-app/releases/tag/v1")).toBe("every-app/every-app");
    expect(parseGithubRepo("every-app/every-app")).toBe("every-app/every-app");
    expect(parseGithubRepo("http://github.com/every-app/every-app")).toBeNull();
    expect(parseGithubRepo("https://example.com/every-app/every-app")).toBeNull();
    expect(parseGithubRepo("https://github.com/every-app")).toBeNull();
  });
});

describe("fetchGithubReleaseAsset", () => {
  it("downloads the latest release's asset, takes its tag from the redirect, and sends no credentials", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [
        { tag: "gateway-v0.3.0", assets: { [ASSET]: file } },
        { tag: "gateway-v0.2.0", assets: { [ASSET]: file } },
      ],
    });

    const download = await fetchGithubReleaseAsset({
      repo: "https://github.com/every-app/every-app",
      asset: ASSET,
      fetch: github.fetch,
    });

    expect(download).toMatchObject({
      tag: "gateway-v0.3.0",
      repo: "every-app/every-app",
      url: `https://github.com/every-app/every-app/releases/latest/download/${ASSET}`,
    });
    expect(fs.readFileSync(download.tarball, "utf8")).toBe("a release");
    // Never the shared temp dir.
    expect(download.tarball.startsWith(path.join(process.env["HOME"]!, ".everyapp"))).toBe(true);
    expect(github.requests.map((request) => new URL(request.url).hostname)).toEqual([
      "github.com",
      "github.com",
      "release-assets.githubusercontent.com",
    ]);
    for (const { init } of github.requests) {
      expect(init).toMatchObject({ redirect: "manual", credentials: "omit" });
      expect(Object.keys(init?.headers ?? {}).map((name) => name.toLowerCase())).not.toContain(
        "authorization",
      );
    }
    await download.cleanup();
    expect(fs.existsSync(download.tarball)).toBe(false);
  });

  it("downloads a release by its tag", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [
        { tag: "gateway-v0.3.0", assets: {} },
        { tag: "gateway-v0.2.0", assets: { [ASSET]: file } },
      ],
    });
    const download = await fetchGithubReleaseAsset({
      repo: "every-app/every-app",
      asset: ASSET,
      tag: "gateway-v0.2.0",
      fetch: github.fetch,
    });
    expect(download.tag).toBe("gateway-v0.2.0");
    await download.cleanup();
  });

  it("says the repository has no release with the asset when GitHub answers 404", async () => {
    // A private repository's releases are a 404 to an anonymous client.
    const github = fakeGithubReleases({});
    await expect(
      fetchGithubReleaseAsset({ repo: "every-app/private-every-app", asset: ASSET, fetch: github.fetch }),
    ).rejects.toMatchObject({
      code: "RELEASE_NOT_FOUND",
      message: expect.stringContaining(
        `every-app/private-every-app has no published release with ${ASSET} that can be downloaded without signing in`,
      ),
    });
  });
});

describe("downloadRelease", () => {
  it("refuses a download larger than the limit, by its length or as it streams", async () => {
    const big = (headers: Record<string, string>) =>
      (async () =>
        new Response("x".repeat(64), { status: 200, headers })) as unknown as typeof fetch;

    await expect(
      downloadRelease("https://example.com/r.tar.gz", {
        fetch: big({ "content-length": String(300 * 1024 * 1024) }),
      }),
    ).rejects.toMatchObject({ code: "RELEASE_TOO_LARGE" });

    await expect(
      downloadRelease("https://example.com/r.tar.gz", { fetch: big({}), maxBytes: 16 }),
    ).rejects.toMatchObject({ code: "RELEASE_TOO_LARGE" });
    // Nothing left behind.
    const tmp = path.join(process.env["HOME"]!, ".everyapp", "cf", "tmp");
    expect(fs.readdirSync(tmp).filter((entry) => entry.startsWith("release-download-"))).toEqual([]);
  });

  it("follows redirects to HTTPS only", async () => {
    const fetchImpl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://example.com/r.tar.gz" },
      })) as unknown as typeof fetch;
    await expect(
      downloadRelease("https://example.com/r.tar.gz", { fetch: fetchImpl }),
    ).rejects.toMatchObject({
      code: "RELEASE_DOWNLOAD_FAILED",
      message: expect.stringContaining("which isn't an HTTPS URL"),
    });
    await expect(downloadRelease("http://example.com/r.tar.gz")).rejects.toMatchObject({
      code: "RELEASE_DOWNLOAD_FAILED",
    });
  });

  it("gives up after its timeout", async () => {
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;
    await expect(
      downloadRelease("https://example.com/r.tar.gz", { fetch: hangs, timeoutMs: 10 }),
    ).rejects.toMatchObject({
      code: "RELEASE_DOWNLOAD_FAILED",
      message: "Downloading https://example.com/r.tar.gz timed out.",
    });
  });
});
