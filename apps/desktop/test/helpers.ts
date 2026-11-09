import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore, type Cipher } from "../src/main/auth/store";

/** A stand-in for safeStorage: reversible, and visibly not plaintext. */
export const fakeCipher: Cipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(Buffer.from(s, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (d) => Buffer.from(d.map((b) => b ^ 0x5a)).toString("utf8"),
};

export function tempStore(cipher: Cipher = fakeCipher): { store: SecretStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "everyapp-test-")), "signin.bin");
  const store = new SecretStore(path, cipher);
  store.load();
  return { store, path };
}
