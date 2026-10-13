/**
 * Dev-environment state for `everyapp dev`: a persistent local RS256 keypair
 * and the `.dev.vars` entries that deliver its public key to the app's Worker
 * (the same env var a production deploy sets).
 *
 * The keypair lives in `.everyapp/dev-keys.json` (gitignored) so the identity
 * key is stable across restarts — `.dev.vars` never goes stale.
 */
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { DEV_ISSUER } from "@every-app/perimeter/dev";
import { ensureGitignored } from "@/lib/gitignore";

export const PUBLIC_KEYS_ENV = "EVERYAPP_IDENTITY_PUBLIC_KEYS";
const ISSUER_ENV = "EVERYAPP_IDENTITY_ISSUER";
/** Set by the app's cloudflare.config.ts in development; no longer written here. */
const DEV_FLAG_ENV = "EVERYAPP_DEV";
const DEV_DIR = ".everyapp";
const KEYS_FILE = "dev-keys.json";
const DEV_VARS_FILE = ".dev.vars";

interface DevKeys {
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Load (or generate and persist) the local dev RS256 keypair. */
export function ensureDevKeys(appDir: string): DevKeys {
  const dir = path.join(appDir, DEV_DIR);
  const file = path.join(dir, KEYS_FILE);

  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as DevKeys;
    if (parsed.privateKeyPem && parsed.publicKeyPem) return parsed;
  }

  // Gitignore the directory BEFORE the private key is ever written, so a
  // `git add` between key generation and a later gitignore append cannot
  // capture it. (The dev key is also scoped to a distinct kid the SDK only
  // trusts under EVERYAPP_DEV, so a leak can't sign prod-trusted tokens — but
  // a committed private key is still never acceptable.)
  ensureGitignored(appDir, `${DEV_DIR}/`);

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keys: DevKeys = { privateKeyPem: privateKey, publicKeyPem: publicKey };

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/**
 * Write the dev identity to the app root's `.dev.vars`, where the Cloudflare
 * Vite plugin fills the secrets `cloudflare.config.ts` declares:
 *  - EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON array of PEM strings (one dotenv-safe
 *    line; PEM newlines are JSON-escaped).
 *  - EVERYAPP_IDENTITY_ISSUER: the issuer the local gateway signs with.
 * Other lines (e.g. a developer's OPENAI_API_KEY) are kept. Vars left in the
 * old `.everyapp/.dev.vars` move here.
 */
export function upsertDevVars(appDir: string, publicKeyPem: string): void {
  const file = path.join(appDir, DEV_VARS_FILE);
  const lines = readLines(file);

  const legacyFile = path.join(appDir, DEV_DIR, DEV_VARS_FILE);
  for (const line of readLines(legacyFile)) {
    const key = line.split("=", 1)[0]!;
    if (!lines.some((existing) => existing.startsWith(`${key}=`))) {
      lines.push(line);
    }
  }

  upsertLine(lines, PUBLIC_KEYS_ENV, JSON.stringify([publicKeyPem]));
  upsertLine(lines, ISSUER_ENV, DEV_ISSUER);
  const kept = lines.filter((line) => !line.startsWith(`${DEV_FLAG_ENV}=`));

  ensureGitignored(appDir, DEV_VARS_FILE);
  fs.writeFileSync(file, kept.join("\n") + "\n");
  fs.rmSync(legacyFile, { force: true });
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

/** Replace the `KEY=...` line in place, or append it. Mutates `lines`. */
function upsertLine(lines: string[], key: string, value: string): void {
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
}
