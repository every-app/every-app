import { describe, expect, it } from "vitest";
import { hashAppToken } from "./app-token-hash";

describe("hashAppToken", () => {
  it("is deterministic for same token and secret", async () => {
    const hash1 = await hashAppToken("token-abc", "secret-123");
    const hash2 = await hashAppToken("token-abc", "secret-123");

    expect(hash1).toBe(hash2);
  });

  it("changes when token changes", async () => {
    const hash1 = await hashAppToken("token-abc", "secret-123");
    const hash2 = await hashAppToken("token-def", "secret-123");

    expect(hash1).not.toBe(hash2);
  });

  it("changes when secret changes", async () => {
    const hash1 = await hashAppToken("token-abc", "secret-123");
    const hash2 = await hashAppToken("token-abc", "secret-456");

    expect(hash1).not.toBe(hash2);
  });
});
