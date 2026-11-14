import fs from "node:fs";
import { DEFAULT_GATEWAY_NAMES, gatewayNames } from "@every-app/perimeter/manifest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNdjsonSink, type EventSink } from "@/lib/output/events";
import { FakeCloudflare } from "@/test/fakeCloudflare";
import { buildGatewayRelease } from "@/test/gatewayRelease";
import type { InstallRecord } from "./install";
import { liveGatewaySource } from "./liveRelease";
import { openRelease, type GatewayRelease } from "./release";
import {
  ensureLiveReleaseSaved,
  isReleaseSaved,
  pruneSavedReleases,
  releaseKey,
  removeSavedReleases,
  saveRelease,
} from "./releaseStore";

const NAMES = DEFAULT_GATEWAY_NAMES;
const BUCKET = "every-app-gateway--releases";

let account: FakeCloudflare;
let tarball: string;
let release: GatewayRelease;
let events: any[];
let out: EventSink;

beforeEach(async () => {
  account = new FakeCloudflare();
  tarball = await buildGatewayRelease();
  release = await openRelease(tarball);
  events = [];
  out = createNdjsonSink((line) => events.push(JSON.parse(line)));
});

afterEach(async () => {
  await release.cleanup();
  fs.rmSync(tarball, { force: true });
});

const keys = (bucket = BUCKET) => [...(account.bucketObjects.get(bucket)?.keys() ?? [])].sort();
const warnings = () => events.filter((event) => event.type === "warning").map((event) => event.code);
const store = () => ({ cf: account.cf, names: NAMES });

/** The install row of a Gateway running `release`, built from a checkout no machine has. */
function installed(over: Partial<InstallRecord> = {}) {
  return {
    releaseVersion: release.manifest.version,
    releaseSha256: release.manifest.sha256,
    releaseOrder: { schema: 1, committedAt: Date.parse("2026-10-12T00:00:00.000Z") },
    sourceTreeSha256: "tree-1",
    releaseOrigin: { kind: "checkout" } as const,
    ...over,
  };
}

describe("the Gateway releases saved in the account's R2", () => {
  it("names a bucket per Gateway, which no other Gateway's names can be", () => {
    expect(NAMES.releases).toBe(BUCKET);
    expect(gatewayNames("demo").releases).toBe("every-app-gateway-demo--releases");
  });

  it("saves a release once, under its SHA-256, creating the bucket on the first save", async () => {
    expect(await isReleaseSaved(account.cf, NAMES, release.manifest.sha256)).toBe(false);

    await saveRelease({ ...store(), out, release });
    expect(keys()).toEqual([releaseKey(release.manifest.sha256)]);
    expect(account.bucketObjects.get(BUCKET)!.get(keys()[0]!)!.body.equals(fs.readFileSync(tarball))).toBe(true);
    expect(await isReleaseSaved(account.cf, NAMES, release.manifest.sha256)).toBe(true);

    // Again: nothing is uploaded.
    const puts = () => account.cf.calls.filter((call) => call.args[2] === "put").length;
    const before = puts();
    await saveRelease({ ...store(), out, release });
    expect(puts()).toBe(before);
    expect(warnings()).toEqual([]);
  });

  it("warns and goes on when it can't be saved", async () => {
    account.r2NotEnabled = true;
    await expect(saveRelease({ ...store(), out, release })).resolves.toBeNull();
    expect(warnings()).toEqual(["GATEWAY_RELEASE_NOT_SAVED"]);
    const warning = events.find((event) => event.type === "warning");
    expect(warning.message).toContain("Couldn't save this Gateway release to R2");
    expect(warning.data.rerun).toMatch(/ update$/);
  });

  it("keeps the live release and the two saved last; the rest go, and nothing that isn't a release", async () => {
    account.buckets.set(BUCKET, { objects: 0 });
    const old = ["a", "b", "c", "d"].map((letter) => releaseKey(letter.repeat(64)));
    for (const key of [...old, "notes.txt"]) {
      account.cf.calls.length = 0;
      await account.cf.run({ plane: "account", mode: "json", args: ["r2", "objects", "put", key, "--bucket-name", BUCKET, "--file", tarball] });
    }
    const saved = await saveRelease({ ...store(), out, release });
    // The live one is the oldest saved here: kept all the same.
    await pruneSavedReleases({ ...store(), saved: saved!, liveSha256: "a".repeat(64) });
    expect(keys()).toEqual([old[0]!, old[3]!, releaseKey(release.manifest.sha256), "notes.txt"].sort());
  });

  it("a rebind takes the live release from R2 on a machine with no checkout, checked against the row", async () => {
    await saveRelease({ ...store(), out, release });
    const source = liveGatewaySource({ install: installed(), store: store(), out, cliVersion: "0.4.0", checkoutRoot: () => null });

    await expect(source.describe()).resolves.toMatchObject({ sha256: release.manifest.sha256 });
    const live = await source.open();
    await live.cleanup();
    expect(live.manifest.sha256).toBe(release.manifest.sha256);
    expect(live.saved).toBe(true);
    // What the install row records again is what it recorded.
    expect(live.source).toMatchObject({ origin: { kind: "checkout" }, treeSha256: "tree-1" });
    expect(events.filter((event) => event.step === "gateway.release").map((event) => event.message)).toEqual([
      `Using the live Gateway ${release.manifest.version} from its saved copy in R2`,
    ]);
  });

  it("a saved object that isn't the row's release is never deployed: the older rules, then a refusal", async () => {
    // Another release's bytes under the live one's key.
    const other = await buildGatewayRelease({ builtAt: "2026-10-20T00:00:00.000Z" });
    const otherRelease = await openRelease(other);
    await saveRelease({ ...store(), out, release: { tarball: other, manifest: release.manifest } });
    const source = liveGatewaySource({ install: installed(), store: store(), out, cliVersion: "0.4.0", checkoutRoot: () => null });
    await expect(source.open()).rejects.toMatchObject({
      code: "GATEWAY_RELEASE_UNAVAILABLE",
      rerunNote: "from a checkout of the Gateway's repository, then run this again",
    });

    // Bytes that are no release at all.
    account.bucketObjects.get(BUCKET)!.set(releaseKey(release.manifest.sha256), { body: Buffer.from("not a tarball"), lastModified: "2026-11-14T00:00:00.000Z" });
    await expect(
      liveGatewaySource({ install: installed(), store: store(), out, cliVersion: "0.4.0", checkoutRoot: () => null }).open(),
    ).rejects.toMatchObject({ code: "GATEWAY_RELEASE_UNAVAILABLE" });
    await otherRelease.cleanup();
    fs.rmSync(other, { force: true });
  });

  it("with nothing saved, a rebind is refused as before, saying an update saves it", async () => {
    const source = liveGatewaySource({ install: installed(), store: store(), out, cliVersion: "0.4.0", checkoutRoot: () => null });
    await expect(source.describe()).rejects.toMatchObject({
      code: "GATEWAY_RELEASE_UNAVAILABLE",
      message: expect.stringContaining("Update the Gateway first: that also saves its release in its Cloudflare account"),
    });
  });

  it("an up-to-date update saves the live release when it isn't; another build of it is not saved as it", async () => {
    await ensureLiveReleaseSaved({ ...store(), out, liveSha256: release.manifest.sha256, openRelease: () => openRelease(tarball) });
    expect(keys()).toEqual([releaseKey(release.manifest.sha256)]);
    expect(warnings()).toEqual([]);

    // Saved already: the release isn't even opened.
    await ensureLiveReleaseSaved({
      ...store(),
      out,
      liveSha256: release.manifest.sha256,
      openRelease: () => Promise.reject(new Error("opened")),
    });
    expect(warnings()).toEqual([]);

    await ensureLiveReleaseSaved({ ...store(), out, liveSha256: "f".repeat(64), openRelease: () => openRelease(tarball) });
    expect(keys()).toEqual([releaseKey(release.manifest.sha256)]);
    expect(warnings()).toEqual(["GATEWAY_RELEASE_NOT_SAVED"]);
    expect(events.find((event) => event.type === "warning").data.rerun).toMatch(/ update --redeploy$/);
  });

  it("a teardown empties the bucket of its releases, and of nothing else", async () => {
    await saveRelease({ ...store(), out, release });
    await account.cf.run({ plane: "account", mode: "json", args: ["r2", "objects", "put", "notes.txt", "--bucket-name", BUCKET, "--file", tarball] });
    await removeSavedReleases(account.cf, NAMES);
    expect(keys()).toEqual(["notes.txt"]);
  });
});
