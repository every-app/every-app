/**
 * Mint an owner setup link for a LOCAL gateway (`pnpm dev`, Docker self-host).
 *
 * Deployed gateways get their link from `everyapp setup`. This is the same
 * thing against the local D1 database: it stores only the SHA-256 of a fresh
 * `est_` secret, expires any earlier unused link, and prints
 * `<GATEWAY_URL>/setup#token=…`. It prints nothing but a note once the
 * gateway has an owner.
 *
 * Usage: pnpm setup-link
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import dotenv from "dotenv";
import { LOCAL_D1_ID, runCfLocal } from "./cf-local.mjs";

const LINK_TTL_MS = 24 * 60 * 60 * 1000;

/** Run one statement against the local D1; returns its rows as arrays. */
async function query(sql, params = []) {
  const [result] = await runCfLocal([
    "d1",
    "raw",
    LOCAL_D1_ID,
    "--sql",
    sql,
    ...params.flatMap((value) => ["--params", String(value)]),
  ]);
  return result?.results?.rows ?? [];
}

function gatewayUrl() {
  const local = [".dev.vars", ".env"].find((file) => existsSync(file));
  const localEnv = local ? dotenv.parse(readFileSync(local, "utf8")) : {};
  return (
    process.env.GATEWAY_URL ||
    localEnv.GATEWAY_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

async function main() {
  const owners = await query(
    "SELECT 1 AS found FROM members WHERE role = ? LIMIT 1",
    ["owner"],
  );
  if (owners.length > 0) {
    console.log("This gateway already has an owner; no setup link needed.");
    return;
  }

  const token = `est_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const now = Date.now();
  await query(
    "UPDATE owner_setup_tokens SET expires_at = ? WHERE kind = 'claim' AND consumed_at IS NULL",
    [now],
  );
  await query(
    "INSERT INTO owner_setup_tokens (id, kind, token_hash, expires_at) VALUES (?, 'claim', ?, ?)",
    [randomUUID(), tokenHash, now + LINK_TTL_MS],
  );

  console.log(
    "\nOpen this one-time link within 24 hours to create the owner account:\n",
  );
  console.log(`  ${gatewayUrl()}/setup#token=${token}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
