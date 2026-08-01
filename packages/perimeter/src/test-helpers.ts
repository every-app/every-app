/**
 * Shared test helpers for the perimeter. Not shipped in production bundles
 * (only imported by *.test.ts and the dev gateway).
 */
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";

export interface TestKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Generate an extractable RS256 keypair and export both halves as PEM. */
export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  return {
    privateKeyPem: await exportPKCS8(privateKey),
    publicKeyPem: await exportSPKI(publicKey),
  };
}
