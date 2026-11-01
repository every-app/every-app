const USER_PAT_HASH_CONTEXT = "every-app-gateway:user-pat:v1";

/**
 * Computes an HMAC-SHA256 hash for user PATs using BETTER_AUTH_SECRET.
 * The context prefix provides domain separation from other secret uses.
 */
export async function hashUserPat(
  token: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const keyMaterial = encoder.encode(secret);
  const data = encoder.encode(`${USER_PAT_HASH_CONTEXT}:${token}`);

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
