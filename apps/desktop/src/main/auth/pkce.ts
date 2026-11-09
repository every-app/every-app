import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 7636 proof key, S256 only (port of HelperCore/PKCE.swift). */
export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function base64url(data: Buffer | Uint8Array): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An opaque URL-safe token, for `state`. */
export function randomToken(bytes = 16): string {
  return base64url(randomBytes(bytes));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/** A fresh verifier: 32 random bytes, base64url, 43 characters (256 bits). */
export function createPkce(verifier: string = base64url(randomBytes(32))): Pkce {
  return { verifier, challenge: challengeFor(verifier), method: "S256" };
}

/** RFC 7636 §4.1: 43–128 characters from [A-Z a-z 0-9 - . _ ~]. */
export function isValidVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
