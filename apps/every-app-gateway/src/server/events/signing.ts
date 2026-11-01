/**
 * The signature on every webhook delivery (docs/design/2026-10-events-out.md,
 * section 2): HMAC-SHA256 with the subscription's secret over
 * `<timestamp>.<body>`, carried as `t=<seconds>,v1=<hex>` so a receiver
 * recomputes it and refuses a stale timestamp. WebCrypto only, as the
 * Worker has it. `verifyEventSignature` is what the docs' snippets and the
 * tests do on the other side: it compares in constant time (WebCrypto's
 * verify) and refuses a `t` outside the tolerance, and it accepts any of
 * several `v1` values so a secret can be rotated without a gap.
 */
import {
  EVENT_SIGNATURE_TOLERANCE_SECONDS,
  eventSigningInput,
  formatEventSignature,
  parseEventSignature,
} from "@every-app/sdk/internal";

const encoder = new TextEncoder();

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The hex HMAC-SHA256 of `<timestamp>.<body>` under `secret`. */
async function signEvent(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(eventSigningInput(timestamp, body)),
  );
  return toHex(digest);
}

/** The whole `X-EveryApp-Signature` value for a body sent at `timestamp`. */
export async function eventSignatureHeader(
  secret: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return formatEventSignature(
    timestamp,
    await signEvent(secret, timestamp, body),
  );
}

type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "expired" | "mismatch" };

/**
 * Check a received signature the way a subscriber should: parse the header,
 * refuse a timestamp more than the tolerance away from `now`, then verify
 * each `v1` against the secret in constant time.
 */
export async function verifyEventSignature(
  secret: string,
  header: string | null | undefined,
  body: string,
  options: { now?: Date; toleranceSeconds?: number } = {},
): Promise<SignatureCheck> {
  const parsed = parseEventSignature(header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance =
    options.toleranceSeconds ?? EVENT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { ok: false, reason: "expired" };
  }
  const key = await hmacKey(secret, "verify");
  const data = encoder.encode(eventSigningInput(parsed.timestamp, body));
  for (const candidate of parsed.v1) {
    if (await crypto.subtle.verify("HMAC", key, fromHex(candidate), data)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "mismatch" };
}
