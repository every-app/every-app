import { describe, expect, it } from "vitest";
import { hashUserPat } from "./user-pat-hash";

describe("hashUserPat", () => {
  it("is deterministic for same token and secret", async () => {
    const hash1 = await hashUserPat("epat_abc", "secret-123");
    const hash2 = await hashUserPat("epat_abc", "secret-123");

    expect(hash1).toBe(hash2);
  });

  it("changes when token changes", async () => {
    const hash1 = await hashUserPat("epat_abc", "secret-123");
    const hash2 = await hashUserPat("epat_def", "secret-123");

    expect(hash1).not.toBe(hash2);
  });

  it("uses a separate context from app tokens", async () => {
    const hash = await hashUserPat("eat_abc", "secret-123");

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
