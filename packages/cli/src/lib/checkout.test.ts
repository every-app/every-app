import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { checkoutRoot, isInCheckout } from "./checkout";

describe("the checkout this CLI runs from", () => {
  it("is found up from the CLI's own files", () => {
    const root = checkoutRoot();
    expect(fs.existsSync(path.join(root, "apps", "every-app-gateway", "scripts", "build-release.ts"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, "packages", "cli", "package.json"), "utf8")).name).toBe("everyapp");
  });

  it("says so when the CLI isn't in one", () => {
    const outside = pathToFileURL(path.join(os.tmpdir(), "everyapp", "dist", "index.js")).href;
    expect(() => checkoutRoot(outside)).toThrow(expect.objectContaining({ code: "CHECKOUT_MISSING" }));
  });

  it("holds the directories below its root, and no others", () => {
    const root = checkoutRoot();
    expect(isInCheckout(root, root)).toBe(true);
    expect(isInCheckout(path.join(root, "apps", "todo-app"), root)).toBe(true);
    expect(isInCheckout(path.join(root, "apps", "not-yet-created"), root)).toBe(true);
    expect(isInCheckout(path.dirname(root), root)).toBe(false);
    expect(isInCheckout(`${root}-other`, root)).toBe(false);
  });
});
