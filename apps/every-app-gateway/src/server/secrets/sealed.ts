/**
 * Sealed values at rest (docs/design/2026-10-oauth-providers.md section 6):
 * the OAuth tokens and client secrets the Gateway keeps in D1. AES-256-GCM
 * through WebCrypto with a random 96-bit nonce per value, written as
 * `v1.<nonce>.<ciphertext>` in base64url. The key is derived once per
 * isolate (per secret value) with HKDF-SHA256 from BETTER_AUTH_SECRET, an
 * install-owned secret every gateway has, under the info string
 * `everyapp:oauth:v1`; `v1` is the version to rotate under. A value that
 * does not open (another secret, tampered, malformed) is null: the caller
 * treats it as lost, never as an error to retry.
 *
 * The threat model's `oauth.tokens-sealed-at-rest` and
 * `oauth.client-secret-sealed-at-rest` rows are this module.
 */

const VERSION = "v1";
const INFO = "everyapp:oauth:v1";
const NONCE_BYTES = 12;

export interface SealingEnv {
  BETTER_AUTH_SECRET?: string;
}

const keys = new Map<string, Promise<CryptoKey>>();

/** Why a value can't be sealed: no secret to derive the key from. */
export class SealingUnavailableError extends Error {
  constructor() {
    super("BETTER_AUTH_SECRET is not set, so nothing can be sealed");
    this.name = "SealingUnavailableError";
  }
}

function deriveKey(secret: string): Promise<CryptoKey> {
  let pending = keys.get(secret);
  if (!pending) {
    pending = (async () => {
      const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(INFO),
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keys.set(secret, pending);
    pending.catch(() => keys.delete(secret));
  }
  return pending;
}

/** The key for `env`, or throws {@link SealingUnavailableError}. */
function keyFor(env: SealingEnv): Promise<CryptoKey> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new SealingUnavailableError();
  return deriveKey(secret);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** `plaintext` sealed under the gateway's key, as `v1.<nonce>.<ciphertext>`. */
export async function seal(
  plaintext: string,
  env: SealingEnv,
): Promise<string> {
  const key = await keyFor(env);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${VERSION}.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Whether `value` has the shape {@link seal} writes (not whether it opens). */
export function isSealed(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 3 &&
    parts[0] === VERSION &&
    /^[A-Za-z0-9_-]{16}$/.test(parts[1]!) &&
    /^[A-Za-z0-9_-]{22,}$/.test(parts[2]!)
  );
}

/**
 * The plaintext of a value {@link seal} wrote, or null when it does not
 * open: another secret, a tampered byte, a malformed string, a version
 * this gateway doesn't know, or no secret to derive the key from.
 */
export async function open(
  sealed: string,
  env: SealingEnv,
): Promise<string | null> {
  if (!isSealed(sealed)) return null;
  const [, nonceText, ciphertextText] = sealed.split(".") as [
    string,
    string,
    string,
  ];
  const nonce = fromBase64Url(nonceText);
  const ciphertext = fromBase64Url(ciphertextText);
  if (!nonce || !ciphertext || nonce.length !== NONCE_BYTES) return null;
  let key: CryptoKey;
  try {
    key = await keyFor(env);
  } catch {
    return null;
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/** Forget derived keys (tests). */
export function resetSealingForTests(): void {
  keys.clear();
}
