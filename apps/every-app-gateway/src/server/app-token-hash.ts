const APP_TOKEN_HASH_CONTEXT = "every-app-gateway:app-token:v1";

/**
 * Computes an HMAC-SHA256 hash for app tokens using BETTER_AUTH_SECRET.
 * The context prefix provides domain separation from other secret uses.
 */
export async function hashAppToken(
  token: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(secret);
  const data = encoder.encode(`${APP_TOKEN_HASH_CONTEXT}:${token}`);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, data);
  return toHex(signature);
}

function toHex(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input);
  let out = "";

  for (const value of bytes) {
    out += value.toString(16).padStart(2, "0");
  }

  return out;
}
