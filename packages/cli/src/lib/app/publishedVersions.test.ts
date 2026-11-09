import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { cliVersion } from "@/lib/version";
import { PUBLISHED_VERSION, publishedRange } from "./publishedVersions";

/** Every place the release version is written (scripts/release.mjs writes them all). */
const PACKAGE_JSONS = ["packages/sdk/package.json", "packages/cli/package.json", "apps/every-app-gateway/package.json"];
const SDK_VERSION_FILE = "packages/sdk/src/server/tools.ts";

describe("PUBLISHED_VERSION", () => {
  it("is this everyapp's version", () => {
    expect(PUBLISHED_VERSION).toBe(cliVersion);
  });

  it("is one version across the SDK, the CLI and the Gateway, as `pnpm release` writes it", () => {
    const root = checkoutRoot();
    for (const file of PACKAGE_JSONS) {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
      expect(pkg.version, `${file} (set it with pnpm release <version>)`).toBe(PUBLISHED_VERSION);
    }
    const sdkVersion = /export const SDK_VERSION = "([^"]*)";/.exec(
      fs.readFileSync(path.join(root, SDK_VERSION_FILE), "utf8"),
    )?.[1];
    expect(sdkVersion, SDK_VERSION_FILE).toBe(PUBLISHED_VERSION);
  });

  it("gives a caret range for the published packages and nothing for any other", () => {
    expect(publishedRange("everyapp")).toBe(`^${PUBLISHED_VERSION}`);
    expect(publishedRange("@every-app/sdk")).toBe(`^${PUBLISHED_VERSION}`);
    expect(publishedRange("@every-app/perimeter")).toBeNull();
    expect(publishedRange("toString")).toBeNull();
  });
});
