import { beforeEach, describe, expect, it } from "vitest";
import {
  SealingUnavailableError,
  isSealed,
  open,
  resetSealingForTests,
  seal,
} from "./sealed";

const env = {
  BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuv",
};
const other = {
  BETTER_AUTH_SECRET: "another-secret-0123456789abcdefghijklmnop",
};

describe("sealed values", () => {
  beforeEach(() => resetSealingForTests());

  it("round-trips a value and never writes the same ciphertext twice", async () => {
    const a = await seal("gho_token", env);
    const b = await seal("gho_token", env);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(isSealed(a)).toBe(true);
    expect(a).not.toContain("gho_token");
    expect(await open(a, env)).toBe("gho_token");
    expect(await open(b, env)).toBe("gho_token");
    expect(await open(await seal("", env), env)).toBe("");
  });

  it("does not open under another secret", async () => {
    const sealed = await seal("refresh-1", env);
    expect(await open(sealed, other)).toBeNull();
    expect(await open(sealed, {})).toBeNull();
  });

  it("does not open a tampered or malformed value", async () => {
    const sealed = await seal("refresh-1", env);
    const [v, nonce, ct] = sealed.split(".") as [string, string, string];
    // Flip a character in the middle: the last one may only carry padding bits.
    const flipped = ct.slice(0, 5) + (ct[5] === "A" ? "B" : "A") + ct.slice(6);
    expect(await open(`${v}.${nonce}.${flipped}`, env)).toBeNull();
    expect(await open(`v2.${nonce}.${ct}`, env)).toBeNull();
    expect(await open(`${v}.${nonce}`, env)).toBeNull();
    expect(await open("refresh-1", env)).toBeNull();
    expect(await open("", env)).toBeNull();
    expect(isSealed("v1.short.x")).toBe(false);
  });

  it("refuses to seal without a secret", async () => {
    await expect(seal("x", {})).rejects.toBeInstanceOf(SealingUnavailableError);
  });
});
