import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { fakeGithubReleases } from "@/test/fakeGithub";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import { releaseCacheDir } from "./checkoutRelease";
import type { InstallRecord } from "./install";
import { liveGatewaySource } from "./liveRelease";
import { openRelease, RELEASE_TARBALL, type ReleaseOrigin } from "./release";

let tarball: string;
let sha256: string;
let events: any[];
let out: EventSink;

beforeEach(async () => {
  tarball = await buildGatewayRelease();
  const release = await openRelease(tarball);
  sha256 = release.manifest.sha256;
  await release.cleanup();
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

afterEach(() => fs.rmSync(tarball, { force: true }));

const said = () =>
  events
    .filter((event) => event.step === "gateway.release")
    .map((event) => (event.type === "warning" ? `warning ${event.code}` : event.message));

/** The install row of a Gateway running `tarball`, from `origin`. */
function installed(
  origin: ReleaseOrigin | null,
  over: Partial<InstallRecord> = {},
): Pick<InstallRecord, "releaseVersion" | "releaseSha256" | "releaseOrder" | "sourceTreeSha256" | "releaseOrigin"> {
  return {
    releaseVersion: "0.2.0",
    releaseSha256: sha256,
    releaseOrder: { schema: 1, committedAt: Date.parse("2026-10-12T00:00:00.000Z") },
    sourceTreeSha256: null,
    releaseOrigin: origin,
    ...over,
  };
}

const CLI = "0.3.0-rc.4";
const noCheckout = () => null;

describe("the Gateway a rebind deploys: the live one, had again", () => {
  it("from its GitHub release by tag, whatever this CLI's version; the guard needs no download", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [
        { tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: await buildGatewayRelease({ builtAt: "2026-10-20T00:00:00.000Z" }) } },
        { tag: "gateway-v0.3.0-rc.3", assets: { [RELEASE_TARBALL]: tarball } },
      ],
    });
    const origin = { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.3" } as const;
    const source = liveGatewaySource({
      install: installed(origin),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    });

    // The guard's view is the install row itself: nothing downloaded.
    await expect(source.describe()).resolves.toMatchObject({ version: "0.2.0", sha256, origin });
    expect(github.requests).toHaveLength(0);

    const release = await source.open();
    await release.cleanup();
    expect(release.manifest.sha256).toBe(sha256);
    expect(release.source.origin).toEqual(origin);
    expect(github.requests.every((request) => request.url.includes("gateway-v0.3.0-rc.3") || request.url.includes("release-assets"))).toBe(true);
    expect(said()).toEqual(["Using the live Gateway 0.2.0 from every-app/every-app release gateway-v0.3.0-rc.3"]);
  });

  it("warns when the tag's asset isn't the live bytes any more, and deploys it as an update", async () => {
    const replaced = await buildGatewayRelease({ builtAt: "2026-10-20T00:00:00.000Z" });
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: replaced } }],
    });
    const release = await liveGatewaySource({
      install: installed({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0" }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    }).open();
    await release.cleanup();
    expect(release.manifest.sha256).not.toBe(sha256);
    expect(said()).toEqual(["warning GATEWAY_RELEASE_DIFFERS"]);
  });

  it("falls back to what setup would deploy when the tag is gone, and says so", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const release = await liveGatewaySource({
      install: installed({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.2.9" }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    }).open();
    await release.cleanup();
    expect(release.source.origin).toEqual({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.4" });
    expect(said()[0]).toMatch(/^The live Gateway 0\.2\.0 \(from every-app\/every-app release gateway-v0\.2\.9\) can't be taken again: every-app\/every-app release gateway-v0\.2\.9 can't be downloaded any more\. Deploying the published release for this everyapp instead\.$/);
  });

  it("from a checkout's build cache, by the row's tree hash; without that build, this checkout's own Gateway, said so", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));
    try {
      fs.mkdirSync(releaseCacheDir(root), { recursive: true });
      fs.copyFileSync(tarball, path.join(releaseCacheDir(root), "tree-1.tar.gz"));
      const install = installed({ kind: "checkout" }, { sourceTreeSha256: "tree-1" });

      const hit = liveGatewaySource({ install, out, cliVersion: CLI, checkoutRoot: () => root });
      await expect(hit.describe()).resolves.toMatchObject({ treeSha256: "tree-1", sha256, origin: { kind: "checkout" } });
      const release = await hit.open();
      await release.cleanup();
      expect(release.source).toMatchObject({ treeSha256: "tree-1", origin: { kind: "checkout" } });
      expect(release.manifest.sha256).toBe(sha256);
      expect(said()).toEqual(["Using the live Gateway 0.2.0 from this checkout"]);

      // A row from before origins were recorded reads as a checkout's too.
      events = [];
      await expect(
        liveGatewaySource({ install: installed(null, { sourceTreeSha256: "tree-1" }), out, cliVersion: CLI, checkoutRoot: () => root }).describe(),
      ).resolves.toMatchObject({ treeSha256: "tree-1" });

      // Not cached: this (real) checkout's sources, for the guard to order, announced once.
      events = [];
      const miss = liveGatewaySource({
        install: installed({ kind: "checkout" }, { sourceTreeSha256: "tree-2" }),
        out,
        cliVersion: CLI,
        checkoutRoot: () => checkoutRoot(),
      });
      const described = await miss.describe();
      expect(described.origin).toEqual({ kind: "checkout" });
      expect(described.treeSha256).not.toBe("tree-2");
      await miss.describe();
      expect(said()).toEqual([
        "The live Gateway 0.2.0 (from this checkout) can't be taken again: this checkout hasn't built that tree (its build cache keeps the last few builds). Deploying this checkout's Gateway instead.",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a checkout-built Gateway, from an everyapp with no checkout: the published release, said so", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const source = liveGatewaySource({
      install: installed({ kind: "checkout" }, { sourceTreeSha256: "tree-1" }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    });
    await expect(source.describe()).resolves.toMatchObject({
      origin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.4" },
    });
    expect(said()[0]).toBe(
      "The live Gateway 0.2.0 (from this checkout) can't be taken again: it was built from a checkout, and this everyapp isn't running from one. Deploying the published release for this everyapp instead.",
    );
  });

  it("from the file it was installed with, while it is there", async () => {
    const source = liveGatewaySource({
      install: installed({ kind: "file", path: tarball }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
    });
    await expect(source.describe()).resolves.toMatchObject({ sha256, origin: { kind: "file", path: tarball } });
    const release = await source.open();
    await release.cleanup();
    expect(release.manifest.sha256).toBe(sha256);

    const gone = liveGatewaySource({
      install: installed({ kind: "file", path: "/nowhere/every-app-gateway-release.tar.gz" }),
      out,
      cliVersion: CLI,
      checkoutRoot: () => checkoutRoot(),
    });
    await expect(gone.describe()).resolves.toMatchObject({ origin: { kind: "checkout" } });
    expect(said().at(-1)).toContain("/nowhere/every-app-gateway-release.tar.gz is gone");
  });

  it("with no Gateway installed yet: what setup deploys", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const release = await liveGatewaySource({ install: null, out, cliVersion: CLI, checkoutRoot: noCheckout, fetch: github.fetch }).open();
    await release.cleanup();
    expect(release.source.origin).toMatchObject({ tag: "gateway-v0.3.0-rc.4" });
  });
});
