import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One-time setup links minted by whoever deploys the gateway (the CLI writes
 * rows straight into D1 with the deployer's Cloudflare credentials). Only the
 * SHA-256 of the link secret is stored; the secret itself lives in the URL
 * fragment of `/setup#token=est_…`, which never reaches a server or a log.
 * A row is single-use (`consumed_at`) and short-lived (`expires_at`).
 *
 * A link minted by `everyapp setup` also carries the SHA-256 of a second
 * secret that only the deploying CLI holds (never printed, never in the
 * link): once the link is claimed, that secret retrieves the owner's first
 * deploy token, once (`deploy_token_issued_at`), so the CLI logs itself in.
 * Whoever sees the link in a chat or a transcript can't do the same.
 */
export const ownerSetupTokens = sqliteTable(
  "owner_setup_tokens",
  {
    id: text("id").primaryKey(),
    // "claim" creates the first owner. The column leaves room for other
    // link kinds without rebuilding the table.
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    // The user the claim created. No foreign key: a failed claim removes
    // that user again and must leave the row usable.
    consumedBy: text("consumed_by"),
    cliSecretHash: text("cli_secret_hash").unique(),
    deployTokenIssuedAt: integer("deploy_token_issued_at", {
      mode: "timestamp_ms",
    }),
  },
  (table) => [
    check(
      "owner_setup_tokens_kind_check",
      sql`${table.kind} IN ('claim', 'recovery')`,
    ),
  ],
);
