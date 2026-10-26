import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutRoot, findCheckoutRoot, isInCheckout, templateSource } from "./checkout";

describe("the checkout this CLI runs from", () => {
  it("is found up from the CLI's own files", () => {
    const root = checkoutRoot();
    expect(fs.existsSync(path.join(root, "apps", "every-app-gateway", "scripts", "build-release.ts"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8")).name).toBe("everyapp");
  });

  it("says so when the CLI isn't in one, and takes the template from the installed package then", () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "everyapp-pkg-"));
    try {
      fs.mkdirSync(path.join(pkg, "dist"));
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "everyapp" }));
      const outside = pathToFileURL(path.join(pkg, "dist", "index.js")).href;
      expect(findCheckoutRoot(outside)).toBeNull();
      expect(() => checkoutRoot(outside)).toThrow(/isn't running from a checkout/);
      // The template and the skills then come from the installed package.
      expect(templateSource(outside)).toEqual({
        root: null,
        starterDir: path.join(pkg, "starter"),
        skillsDir: path.join(pkg, "skills"),
      });
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true });
    }
  });

  it("holds the directories below its root, and no others", () => {
    const root = checkoutRoot();
    expect(isInCheckout(root, root)).toBe(true);
    expect(isInCheckout(path.join(root, "apps", "my-app"), root)).toBe(true);
    expect(isInCheckout(path.join(root, "apps", "not-yet-created"), root)).toBe(true);
    expect(isInCheckout(path.dirname(root), root)).toBe(false);
    expect(isInCheckout(`${root}-other`, root)).toBe(false);
  });
});
