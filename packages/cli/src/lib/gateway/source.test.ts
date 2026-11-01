import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { RELEASE_TARBALL } from "./release";
import { gatewayReleaseSource } from "./source";

let tarball: string;
let events: any[];
let out: EventSink;

beforeEach(async () => {
  tarball = await buildGatewayRelease();
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

afterEach(() => fs.rmSync(tarball, { force: true }));

const said = () =>
  events
    .filter((event) => event.step === "gateway.release")
    .map((event) => (event.type === "warning" ? `warning ${event.code}` : event.message));
const noCheckout = () => null;
const CLI = "0.3.0-rc.4";

describe("where the Gateway comes from", () => {
  it("without a checkout: the release for this CLI's version, downloaded once for describe and open", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [
        { tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: tarball } },
        { tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: tarball } },
      ],
    });
    const source = gatewayReleaseSource({
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    });

    const described = await source.describe();
    const release = await source.open();
    try {
      expect(described).toMatchObject({
        version: "0.2.0",
        treeSha256: null,
        sha256: release.manifest.sha256,
        origin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.4" },
      });
      expect(release.source.origin).toEqual(described.origin);
    } finally {
      await release.cleanup();
    }
    // One download (the tag's redirect and the file) for both.
    expect(github.requests).toHaveLength(2);
    expect(said()).toEqual([
      "Downloading the Gateway release gateway-v0.3.0-rc.4...",
      "Using Gateway 0.2.0 from every-app/every-app release gateway-v0.3.0-rc.4",
    ]);
  });

  it("falls back to the latest stable release when this CLI's version has none yet, and says so", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const release = await gatewayReleaseSource({
      out,
      cliVersion: "0.3.1",
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    }).open();
    await release.cleanup();
    expect(release.source.origin).toEqual({
      kind: "github",
      repo: "every-app/every-app",
      tag: "gateway-v0.3.0",
    });
    expect(said()).toEqual([
      "Downloading the Gateway release gateway-v0.3.1...",
      "warning GATEWAY_RELEASE_LATEST",
      "Using Gateway 0.2.0 from every-app/every-app release gateway-v0.3.0",
    ]);
    expect(events.find((event) => event.code === "GATEWAY_RELEASE_LATEST")).toMatchObject({
      message: expect.stringContaining("no Gateway release for everyapp 0.3.1 yet"),
      data: { tag: "gateway-v0.3.1", cliVersion: "0.3.1" },
    });
  });

  it("says when the repository has nothing this CLI can install, and what to do", async () => {
    // The private repository's releases, or a public one with none yet.
    const source = gatewayReleaseSource({
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: fakeGithubReleases({}).fetch,
    });
    await expect(source.open()).rejects.toMatchObject({
      code: "RELEASE_NOT_FOUND",
      message: expect.stringContaining(
        "https://github.com/every-app/every-app has no Gateway release everyapp 0.3.0-rc.4 can install",
      ),
      fix: expect.stringContaining("--release <url|file>"),
    });
  });

  it("from a checkout: what it builds, unless --release names another", async () => {
    const root = checkoutRoot();
    await expect(
      gatewayReleaseSource({ out, cliVersion: CLI, checkoutRoot: () => root }).describe(),
    ).resolves.toMatchObject({ origin: { kind: "checkout" } });

    const named = gatewayReleaseSource({
      out,
      cliVersion: CLI,
      release: tarball,
      checkoutRoot: () => root,
    });
    await expect(named.describe()).resolves.toMatchObject({
      origin: { kind: "file", path: tarball },
      treeSha256: null,
    });
    expect(said()).toEqual([`Using Gateway 0.2.0 from ${tarball}`]);
  });

  it("--release with a release page's URL takes that release, never the version's", async () => {
    const github = fakeGithubReleases({
      "acme/gateway-fork": [
        { tag: "v2", assets: {} },
        { tag: "v1", assets: { [RELEASE_TARBALL]: tarball } },
      ],
    });
    const release = await gatewayReleaseSource({
      out,
      cliVersion: CLI,
      release: "https://github.com/acme/gateway-fork/releases/tag/v1",
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    }).open();
    await release.cleanup();
    expect(release.source.origin).toEqual({ kind: "github", repo: "acme/gateway-fork", tag: "v1" });
    expect(github.requests.every((request) => request.url.includes("acme/gateway-fork"))).toBe(true);
  });

  it("--release with a tarball's URL downloads it", async () => {
    const body = fs.readFileSync(tarball);
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const release = await gatewayReleaseSource({
      out,
      cliVersion: CLI,
      release: "https://downloads.example.com/gateway.tar.gz",
      checkoutRoot: noCheckout,
      fetch: fetchImpl,
    }).open();
    await release.cleanup();
    expect(release.source.origin).toEqual({
      kind: "url",
      url: "https://downloads.example.com/gateway.tar.gz",
    });
  });

  it("refuses a download whose files don't match its release.json (damaged or altered in transit)", async () => {
    // The same release with one byte of its Worker changed, release.json left as it was.
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "altered-release-"));
    const altered = path.join(work, RELEASE_TARBALL);
    try {
      execFileSync("tar", ["-xzf", tarball, "-C", work]);
      const worker = path.join(work, ".cloudflare/output/v0/workers/default/bundle/index.js");
      fs.appendFileSync(worker, "\n// altered\n");
      execFileSync("tar", ["-czf", altered, "-C", work, ".cloudflare", "drizzle", "release.json"]);
      const github = fakeGithubReleases({
        "every-app/every-app": [{ tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: altered } }],
      });
      await expect(
        gatewayReleaseSource({ out, cliVersion: CLI, checkoutRoot: noCheckout, fetch: github.fetch }).open(),
      ).rejects.toMatchObject({ code: "RELEASE_CORRUPT" });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it("--release with neither a URL nor a file says so", async () => {
    await expect(
      gatewayReleaseSource({
        out,
        cliVersion: CLI,
        release: "./nowhere.tar.gz",
        checkoutRoot: noCheckout,
      }).open(),
    ).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
  });
});
