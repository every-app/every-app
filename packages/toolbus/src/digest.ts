/**
 * Keyed fingerprints of tool-call arguments for the audit trail: equal
 * arguments match across calls, but the values never leave the request and
 * can't be guessed back from the log.
 */
import { canonicalJson } from "@every-app/sdk/internal";

const DIGEST_HEX_CHARS = 32;

/**
 * First 32 hex characters of HMAC-SHA256(secret, `<context>:<canonical JSON>`).
 * The context separates this use of the secret from its others.
 */
export function createArgumentsDigester(
  secret: string,
  context: string,
): (args: unknown) => Promise<string> {
  const encoder = new TextEncoder();
  // Typed off the global so the CLI, compiled with Node's types alone and
  // no CryptoKey global, can import this package too.
  let key: ReturnType<typeof crypto.subtle.importKey> | undefined;
  return async (args) => {
    key ??= crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      await key,
      encoder.encode(`${context}:${canonicalJson(args)}`),
    );
    let hex = "";
    for (const byte of new Uint8Array(signature)) {
      hex += byte.toString(16).padStart(2, "0");
    }
    return hex.slice(0, DIGEST_HEX_CHARS);
  };
}
