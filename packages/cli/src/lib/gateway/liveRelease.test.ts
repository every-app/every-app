import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { EveryAppError } from "@/lib/errors";
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

/** The rebind refuses (GATEWAY_RELEASE_UNAVAILABLE), naming `update`, and says nothing was deployed. */
async function expectUnavailable(attempt: Promise<unknown>, why: string): Promise<EveryAppError> {
  const error = await attempt.then(
    () => {
      throw new Error("expected GATEWAY_RELEASE_UNAVAILABLE");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(EveryAppError);
  const refusal = error as EveryAppError;
  expect(refusal.code).toBe("GATEWAY_RELEASE_UNAVAILABLE");
  expect(refusal.message).toContain(why);
  expect(refusal.rerun).toMatch(/ update$/);
  expect(said()).toEqual([]);
  return refusal;
}
const noCheckout = () => null;

describe("the Gateway a rebind deploys: the live one, had again, or a refusal", () => {
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

  it("refuses when the tag's asset isn't the live bytes any more: never deployed as an update", async () => {
    const replaced = await buildGatewayRelease({ builtAt: "2026-10-20T00:00:00.000Z" });
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0", assets: { [RELEASE_TARBALL]: replaced } }],
    });
    const source = liveGatewaySource({
      install: installed({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0" }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    });
    await expectUnavailable(source.open(), "its SHA-256 changed");
  });

  it("refuses when the tag is gone, naming update; nothing else is deployed", async () => {
    const github = fakeGithubReleases({
      "every-app/every-app": [{ tag: "gateway-v0.3.0-rc.4", assets: { [RELEASE_TARBALL]: tarball } }],
    });
    const source = liveGatewaySource({
      install: installed({ kind: "github", repo: "every-app/every-app", tag: "gateway-v0.2.9" }),
      out,
      cliVersion: CLI,
      checkoutRoot: noCheckout,
      fetch: github.fetch,
    });
    const error = await expectUnavailable(
      source.open(),
      "every-app/every-app release gateway-v0.2.9 can't be downloaded any more",
    );
    expect(error.message).toMatch(/^The live Gateway 0\.2\.0 \(from every-app\/every-app release gateway-v0\.2\.9\) can't be fetched again/);
    expect(github.requests.some((request) => request.url.includes("gateway-v0.3.0-rc.4"))).toBe(false);
  });

  it("from a checkout's build cache, by the row's tree hash; without that build, refused", async () => {
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

      // Not cached: refused, never this checkout's own sources.
      const miss = liveGatewaySource({
        install: installed({ kind: "checkout" }, { sourceTreeSha256: "tree-2" }),
        out,
        cliVersion: CLI,
        checkoutRoot: () => checkoutRoot(),
      });
      await expectUnavailable(miss.describe(), "this checkout's Gateway sources aren't the live ones");
      await expectUnavailable(miss.open(), "this checkout's Gateway sources aren't the live ones");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds again from this checkout when its sources are the live tree: the same Gateway, not an upgrade", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));
    try {
      const built: string[] = [];
      const source = (tree: string | null) =>
        liveGatewaySource({
          install: installed(null, { sourceTreeSha256: "tree-live" }),
          out,
          cliVersion: CLI,
          checkoutRoot: () => root,
          checkoutTree: async () => tree,
          buildCheckout: async () => {
            built.push("build");
            // A build of the same tree, whose bytes differ from the live ones.
            const rebuilt = await buildGatewayRelease({ builtAt: "2026-10-20T00:00:00.000Z" });
            return openRelease(rebuilt, { origin: { kind: "checkout" }, treeSha256: "tree-live", committedAt: 0 });
          },
        });

      await expect(source("tree-live").describe()).resolves.toMatchObject({ treeSha256: "tree-live" });
      const release = await source("tree-live").open();
      await release.cleanup();
      expect(release.source.treeSha256).toBe("tree-live");
      expect(release.manifest.sha256).not.toBe(sha256);
      expect(built).toEqual(["build"]);
      expect(said()).toEqual(["Using the live Gateway 0.2.0 from this checkout"]);

      // Other sources (or none git can list): refused, nothing built, and the row's age said.
      events = [];
      const refusal = await expectUnavailable(source("tree-other").open(), "installed before everyapp recorded where a Gateway comes from");
      expect(refusal.data).toMatchObject({ origin: { kind: "checkout" } });
      await expectUnavailable(source(null).describe(), "installed before everyapp recorded");
      expect(built).toEqual(["build"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a checkout-built Gateway, from an everyapp with no checkout: refused, not the published release", async () => {
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
    await expectUnavailable(source.describe(), "it was built from a checkout, and this everyapp isn't running from one");
    expect(github.requests).toHaveLength(0);
  });

  it("from the file it was installed with, while it is there; refused once it is gone", async () => {
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

    events = [];
    const gone = liveGatewaySource({
      install: installed({ kind: "file", path: "/nowhere/every-app-gateway-release.tar.gz" }),
      out,
      cliVersion: CLI,
      checkoutRoot: () => checkoutRoot(),
    });
    await expectUnavailable(gone.describe(), "/nowhere/every-app-gateway-release.tar.gz is gone");
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
