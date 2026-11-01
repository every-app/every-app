import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkoutRoot } from "@/lib/checkout";
import { PUBLISHED_PACKAGES, PUBLISHED_VERSION, publishedRange } from "./publishedVersions";

const DIRS = { "@every-app/sdk": "packages/sdk", everyapp: "packages/cli" } as const;

describe("PUBLISHED_VERSION", () => {
  it("is a release of the version the checkout is on, so a bump there forces one here", () => {
    for (const name of PUBLISHED_PACKAGES) {
      const pkg = JSON.parse(fs.readFileSync(path.join(checkoutRoot(), DIRS[name], "package.json"), "utf8"));
      expect(pkg.name).toBe(name);
      // 0.3.0-rc.6 is a release on the way to 0.3.0; 0.3.0 itself is too.
      expect(PUBLISHED_VERSION.replace(/-.*$/, ""), `${name}: the checkout is on ${pkg.version}`).toBe(
        pkg.version.replace(/-.*$/, ""),
      );
    }
  });

  it("gives a caret range for the published packages and nothing for any other", () => {
    expect(publishedRange("everyapp")).toBe(`^${PUBLISHED_VERSION}`);
    expect(publishedRange("@every-app/sdk")).toBe(`^${PUBLISHED_VERSION}`);
    expect(publishedRange("@every-app/perimeter")).toBeNull();
    expect(publishedRange("toString")).toBeNull();
  });
});
