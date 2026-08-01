/**
 * Dev-environment state for `everyapp dev`: a persistent local RS256 keypair
 * and the generated config's `.dev.vars` entry that delivers the public key
 * set to the app's worker env (the same env var a production deploy injects).
 *
 * The keypair lives in `.everyapp/dev-keys.json` (gitignored) so the identity
 * key is stable across restarts — `.dev.vars` never goes stale.
 */
import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

export const PUBLIC_KEYS_ENV = "EVERYAPP_IDENTITY_PUBLIC_KEYS";
/** Opts the SDK into accepting the dev identity kid. Never set in production. */
const DEV_FLAG_ENV = "EVERYAPP_DEV";
const DEV_DIR = ".everyapp";
const KEYS_FILE = "dev-keys.json";

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
 * Write the dev identity vars next to the generated Wrangler config (where the
 * Cloudflare Vite plugin reads `.dev.vars`) and migrate the legacy app-root
 * file when it contains only vars managed by this CLI:
 *  - EVERYAPP_IDENTITY_PUBLIC_KEYS: JSON array of PEM strings (one dotenv-safe
 *    line; PEM newlines are JSON-escaped).
 *  - EVERYAPP_DEV=1: opts the SDK into trusting the dev identity kid. This var
 *    is never set in production, so dev-kid tokens are rejected there.
 */
export function upsertDevVars(
  appDir: string,
  wranglerConfigPath: string,
  publicKeyPem: string,
): void {
  const file = path.join(path.dirname(wranglerConfigPath), ".dev.vars");
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  upsertLine(lines, PUBLIC_KEYS_ENV, JSON.stringify([publicKeyPem]));
  upsertLine(lines, DEV_FLAG_ENV, "1");

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  cleanUpLegacyDevVars(appDir, file);
}

function cleanUpLegacyDevVars(appDir: string, currentFile: string): void {
  const legacyFile = path.join(appDir, ".dev.vars");
  if (path.resolve(legacyFile) === path.resolve(currentFile)) return;
  if (!fs.existsSync(legacyFile)) return;

  const content = fs.readFileSync(legacyFile, "utf-8");
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const containsOnlyManagedVars = lines.every((line) =>
    [PUBLIC_KEYS_ENV, DEV_FLAG_ENV].some((key) => line.startsWith(`${key}=`)),
  );

  if (containsOnlyManagedVars) {
    fs.rmSync(legacyFile);
    return;
  }

  console.warn(
    `Every App left ${legacyFile} in place because it contains user-managed content. ` +
      `Move any vars still needed by the worker to ${currentFile}.`,
  );
}

/** Replace the `KEY=...` line in place, or append it. Mutates `lines`. */
function upsertLine(lines: string[], key: string, value: string): void {
  const line = `${key}=${value}`;
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
}

function ensureGitignored(appDir: string, entry: string): void {
  const file = path.join(appDir, ".gitignore");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, entry + "\n");
    return;
  }
  const content = fs.readFileSync(file, "utf-8");
  const present = content
    .split("\n")
    .some((l) => l.trim() === entry || l.trim() === entry.replace(/\/$/, ""));
  if (!present) {
    fs.appendFileSync(file, (content.endsWith("\n") ? "" : "\n") + entry + "\n");
  }
}
