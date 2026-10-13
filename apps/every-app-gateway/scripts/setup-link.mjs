/**
 * Mint an owner setup link for a LOCAL gateway (vite dev, Docker self-host).
 *
 * Deployed gateways get their link from `everyapp gateway deploy` (or
 * `everyapp gateway claim-link`). This is the same thing against the local D1
 * database: it stores only the SHA-256 of a fresh `est_` secret, expires any
 * earlier unused link, and prints `<GATEWAY_URL>/setup#token=…`. It prints
 * nothing but a note once the gateway has an owner.
 *
 * Usage: pnpm setup-link
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";

const DATABASE = "every-app-gateway";
const LINK_TTL_MS = 24 * 60 * 60 * 1000;

function wranglerD1(command) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      DATABASE,
      "--local",
      "--json",
      "--command",
      command,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed:\n${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(result.stdout);
}

function gatewayUrl() {
  const localEnv = existsSync(".env")
    ? dotenv.parse(readFileSync(".env", "utf8"))
    : {};
  return (
    process.env.GATEWAY_URL ||
    localEnv.GATEWAY_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function main() {
  const [ownerQuery] = wranglerD1(
    "SELECT 1 AS found FROM members WHERE role = 'owner' LIMIT 1;",
  );
  if ((ownerQuery?.results ?? []).length > 0) {
    console.log("This gateway already has an owner; no setup link needed.");
    return;
  }

  const token = `est_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  // Every value below is generated here (hex, UUID, integers), never input.
  wranglerD1(
    [
      `UPDATE owner_setup_tokens SET expires_at = ${now} WHERE kind = 'claim' AND consumed_at IS NULL;`,
      `INSERT INTO owner_setup_tokens (id, kind, token_hash, expires_at) VALUES ('${randomUUID()}', 'claim', '${tokenHash}', ${now + LINK_TTL_MS});`,
    ].join(" "),
  );

  console.log(
    "\nOpen this one-time link within 24 hours to create the owner account:\n",
  );
  console.log(`  ${gatewayUrl()}/setup#token=${token}\n`);
}

main();
