/**
 * Owner setup link secrets (`est_` + 32 random bytes, base64url).
 *
 * The deployer stores only the SHA-256 of the secret. It carries 256 bits of
 * entropy, so a plain digest is enough: no pepper, no slow hash, and nothing
 * to rate-limit. The CLI computes the same digest when it mints a link.
 */
export const SETUP_TOKEN_PREFIX = "est_";

/**
 * The second secret `everyapp setup` keeps for itself (`ecs_` + 32 random
 * bytes, base64url): never in the link, stored only as its SHA-256, it
 * retrieves the owner's first deploy token once the link is claimed.
 */
export const CLI_SECRET_PREFIX = "ecs_";

export async function hashSetupToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Compare two digests without leaking where they first differ. */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
