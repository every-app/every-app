// The sign-in and the cached OAuth client ids, encrypted with Electron's `safeStorage` (its key
// lives in the macOS Keychain as "<productName> Safe Storage") and written to one 0600 file in
// userData. See desktop/README.md, "Where tokens live", for why this and not a keychain module.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credentials } from "./providers";
import type { ClientIdCache } from "./signin";
import { normalized } from "./url";

export interface Cipher {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

interface Contents {
  version: 1;
  credentials?: Credentials;
  clients: Record<string, { clientId: string; lastUsed: number; name?: string }>;
  /** The API key for the person's own transcription server (Settings → Transcription). Not part
   * of the sign-in: signing out keeps it. */
  transcriptionKey?: string;
}

export type LoadProblem = "unreadable" | undefined;

export class SecretStore implements ClientIdCache {
  private contents: Contents = { version: 1, clients: {} };
  /** Set when a saved sign-in exists but can't be decrypted (e.g. a rebuild with another
   * signature can't read the last build's Keychain key). */
  loadProblem: LoadProblem;

  /** `memoryOnly`: never read or write the file and never call the cipher, so the Keychain is
   * never touched (dev runs with a token sign-in; see config.ts `keychainDisabled`). A sign-in
   * then lasts until quit. */
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
    private readonly memoryOnly = false,
  ) {}

  load(): void {
    this.loadProblem = undefined;
    if (this.memoryOnly || !existsSync(this.path)) return;
    try {
      const plain = this.cipher.decrypt(readFileSync(this.path));
      const parsed = JSON.parse(plain) as Contents;
      if (parsed && parsed.version === 1) {
        this.contents = { version: 1, clients: parsed.clients ?? {}, credentials: parsed.credentials };
        if (typeof parsed.transcriptionKey === "string" && parsed.transcriptionKey) this.contents.transcriptionKey = parsed.transcriptionKey;
      }
    } catch {
      this.loadProblem = "unreadable";
      this.contents = { version: 1, clients: {} };
    }
  }

  get credentials(): Credentials | undefined {
    return this.contents.credentials;
  }

  setCredentials(credentials: Credentials | undefined): void {
    this.contents.credentials = credentials;
    this.write();
  }

  get transcriptionKey(): string | undefined {
    return this.contents.transcriptionKey;
  }

  /** Empty or undefined forgets it. */
  setTranscriptionKey(key: string | undefined): void {
    if (key) this.contents.transcriptionKey = key;
    else delete this.contents.transcriptionKey;
    this.write();
  }

  entry(issuer: string): { clientId: string; lastUsed: number; name?: string } | undefined {
    return this.contents.clients[normalized(issuer)];
  }

  save(clientId: string, issuer: string, lastUsed: number, name?: string): void {
    this.contents.clients[normalized(issuer)] = { clientId, lastUsed, name };
    this.write();
  }

  forget(issuer: string): void {
    delete this.contents.clients[normalized(issuer)];
    this.write();
  }

  /** Writes atomically; refuses to write plaintext when encryption isn't available. */
  private write(): void {
    if (this.memoryOnly) return;
    if (!this.cipher.isAvailable()) throw new Error("The Keychain isn't available, so Every App can't keep a sign-in.");
    const empty = !this.contents.credentials && !this.contents.transcriptionKey && Object.keys(this.contents.clients).length === 0;
    if (empty) {
      rmSync(this.path, { force: true });
      return;
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, this.cipher.encrypt(JSON.stringify(this.contents)), { mode: 0o600 });
    renameSync(tmp, this.path);
    this.loadProblem = undefined;
  }
}
