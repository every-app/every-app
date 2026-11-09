import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import identity from "../identity.json";
import { exampleBackendUrl, FEATURES, SCRIBE } from "../src/shared/features";
import { parseDeepLink, resolveDeepLink } from "../src/main/calendar/deepLink";

const root = join(import.meta.dirname, "..");

describe("identity.json", () => {
  it("keeps local data and the Keychain item under fixed names, not the display name", () => {
    for (const flavor of [identity.release, identity.dev]) {
      expect(flavor.storageName).toBe(flavor.appId);
      expect(flavor.storageName).not.toContain(" ");
      expect(flavor.storageName).not.toBe(flavor.productName);
    }
    expect(identity.dev.appId).toBe(`${identity.release.appId}.dev`);
    expect(identity.helper.bundleId).toBe(`${identity.release.appId}.helper`);
    expect(identity.dev.scheme).toBe(`${identity.release.scheme}-dev`);
  });

  it("is what electron-builder packages: storageName becomes the packaged productName", () => {
    const config = readFileSync(join(root, "electron-builder.config.cjs"), "utf8");
    expect(config).toContain('require("./identity.json")');
    expect(config).toContain("extraMetadata: { productName: storageName }");
  });

  it("names the helper's bundle id in its embedded Info.plist", () => {
    const plist = readFileSync(join(root, "mac", "Resources", "helper-Info.plist"), "utf8");
    expect(plist).toContain(`<string>${identity.helper.bundleId}</string>`);
    const build = readFileSync(join(root, "mac", "scripts", "build-helper.sh"), "utf8");
    expect(build).toContain(`IDENTIFIER="${identity.helper.bundleId}"`);
  });
});

describe("features", () => {
  it("has one entry per feature id, and Scribe's backend in one place", () => {
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
    expect(SCRIBE.label).toBe("Scribe");
    expect(exampleBackendUrl(SCRIBE)).toBe(`https://${SCRIBE.backend.appId}.example.com`);
  });
});

describe("deep links", () => {
  it("takes everyapp://scribe/record with its event, title, start and join", () => {
    const link = parseDeepLink("everyapp://scribe/record?event=e1&title=Standup&start=2026-11-07T10:00:00Z&join=1");
    expect(link).toEqual({ eventId: "e1", title: "Standup", start: "2026-11-07T10:00:00.000Z", join: true });
    expect(parseDeepLink("everyapp:scribe/record")).toEqual({ eventId: undefined, title: undefined, start: undefined, join: false });
    expect(parseDeepLink("EVERYAPP://Scribe/Record/")).toBeDefined();
  });

  it("refuses other features, commands and schemes", () => {
    expect(parseDeepLink("everyapp://record")).toBeUndefined();
    expect(parseDeepLink("everyapp://dictation/record")).toBeUndefined();
    expect(parseDeepLink("everyapp://scribe/delete")).toBeUndefined();
    expect(parseDeepLink("talk://record")).toBeUndefined();
    // A dev build owns only everyapp-dev, so it never takes the installed app's links.
    expect(parseDeepLink("everyapp://scribe/record", ["everyapp-dev"])).toBeUndefined();
    expect(parseDeepLink("everyapp-dev://scribe/record", ["everyapp-dev"])).toBeDefined();
  });

  it("strips control characters from the title and starts at once only for a known event", () => {
    const link = parseDeepLink("everyapp://scribe/record?event=nope&title=a%00b")!;
    expect(link.title).toBe("ab");
    expect(resolveDeepLink(link, [], "Now")).toEqual({ kind: "confirm", title: "ab", start: undefined, eventId: "nope" });
  });
});
