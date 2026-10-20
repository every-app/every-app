import fs from "node:fs";
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

const used = () =>
  events.filter((event) => event.step === "gateway.release" && event.type === "step");
const noCheckout = () => null;

describe("where the Gateway comes from", () => {
  it("without a checkout: the latest release of every-app/every-app, downloaded once", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.2.0", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const source = gatewayReleaseSource({ out, checkoutRoot: noCheckout, fetch: github.fetch });

    const described = await source.describe();
    const release = await source.open();
    try {
      expect(described).toMatchObject({
        version: "0.2.0",
        treeSha256: null,
        sha256: release.manifest.sha256,
        origin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.2.0" },
      });
      expect(release.source.origin).toEqual(described.origin);
    } finally {
      await release.cleanup();
    }
    // One download (two redirects and the file) for both.
    expect(github.requests).toHaveLength(3);
    expect(used().map((event) => event.message)).toEqual([
      "Downloading the latest Gateway release...",
      "Using Gateway 0.2.0 from every-app/every-app release gateway-v0.2.0.",
    ]);
  });

  it("says when the default repository has nothing to download", async () => {
    // The private repository's releases, or a public one with none yet.
    const source = gatewayReleaseSource({
      out,
      checkoutRoot: noCheckout,
      fetch: fakeGithubReleases({}).fetch,
    });
    await expect(source.open()).rejects.toMatchObject({
      code: "RELEASE_NOT_FOUND",
      message: expect.stringContaining("every-app/every-app has no published release"),
    });
  });

  it("from a checkout: what it builds, unless --release names another", async () => {
    const root = checkoutRoot();
    await expect(
      gatewayReleaseSource({ out, checkoutRoot: () => root }).describe(),
    ).resolves.toMatchObject({ origin: { kind: "checkout" } });

    const named = gatewayReleaseSource({ out, release: tarball, checkoutRoot: () => root });
    await expect(named.describe()).resolves.toMatchObject({
      origin: { kind: "file", path: tarball },
      treeSha256: null,
    });
    expect(used().map((event) => event.message)).toEqual([
      `Using Gateway 0.2.0 from ${tarball}.`,
    ]);
  });

  it("--release with a release page's URL takes that release", async () => {
    const github = fakeGithubReleases({
      "acme/gateway-fork": [
        { tag: "v2", assets: {} },
        { tag: "v1", assets: { [RELEASE_TARBALL]: tarball } },
      ],
    });
    const release = await gatewayReleaseSource({
      out,
      release: "https://github.com/acme/gateway-fork/releases/tag/v1",
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    }).open();
    await release.cleanup();
    expect(release.source.origin).toEqual({ kind: "github", repo: "acme/gateway-fork", tag: "v1" });
  });

  it("--release with a tarball's URL downloads it", async () => {
    const body = fs.readFileSync(tarball);
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const release = await gatewayReleaseSource({
      out,
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

  it("--release with neither a URL nor a file says so", async () => {
    await expect(
      gatewayReleaseSource({ out, release: "./nowhere.tar.gz", checkoutRoot: noCheckout }).open(),
    ).rejects.toMatchObject({ code: "RELEASE_NOT_FOUND" });
  });
});
