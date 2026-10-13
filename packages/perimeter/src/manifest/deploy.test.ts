import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appBindingName, appBindingsDigest } from "./deploy";

describe("appBindingsDigest", () => {
  it("hashes the sorted binding names, whatever order they come in", async () => {
    const names = [appBindingName("every-b"), appBindingName("every-a")];
    const expected = createHash("sha256")
      .update("APP__every-a\nAPP__every-b")
      .digest("hex");

    await expect(appBindingsDigest(names)).resolves.toBe(expected);
    await expect(appBindingsDigest([...names].reverse())).resolves.toBe(
      expected,
    );
  });

  it("has a digest for no apps", async () => {
    await expect(appBindingsDigest([])).resolves.toBe(
      createHash("sha256").update("").digest("hex"),
    );
  });
});
