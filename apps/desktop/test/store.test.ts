import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, type Cipher } from "../src/main/auth/store";

/** A cipher that fails the test if anything touches it (stands in for the Keychain). */
const untouchable: Cipher = {
  isAvailable: () => {
    throw new Error("touched the Keychain");
  },
  encrypt: () => {
    throw new Error("touched the Keychain");
  },
  decrypt: () => {
    throw new Error("touched the Keychain");
  },
};

describe("SecretStore, memory only (dev without the Keychain)", () => {
  it("never reads, writes or calls the cipher", () => {
    const path = join(mkdtempSync(join(tmpdir(), "everyapp-store-")), "signin.bin");
    writeFileSync(path, "an older build's sign-in");
    const store = new SecretStore(path, untouchable, true);
    store.load();
    expect(store.loadProblem).toBeUndefined();
    expect(store.credentials).toBeUndefined();
    store.setCredentials({ kind: "token", appUrl: "http://talk.localhost:8787", token: "dev" });
    store.save("client", "https://gateway.example", Date.now());
    expect(store.credentials).toMatchObject({ kind: "token", token: "dev" });
    expect(store.entry("https://gateway.example")?.clientId).toBe("client");
    store.setCredentials(undefined);
    expect(existsSync(path)).toBe(true); // left alone
  });
});
