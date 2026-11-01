import { describe, expect, it } from "vitest";
import { digestsEqual, hashSetupToken } from "./setup-token";

describe("setup token digests", () => {
  it("is the hex SHA-256 of the link secret, as the CLI stores it", async () => {
    await expect(hashSetupToken("est_abc")).resolves.toBe(
      "c932ca434cbfe06d232b80f3269839937941943715c799cf6501511177607999",
    );
  });

  it("compares digests exactly", () => {
    expect(digestsEqual("abc", "abc")).toBe(true);
    expect(digestsEqual("abc", "abd")).toBe(false);
    expect(digestsEqual("abc", "abcd")).toBe(false);
  });
});
