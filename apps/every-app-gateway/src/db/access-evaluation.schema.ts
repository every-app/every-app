import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The key the Gateway signs its answers to Cloudflare Access's External
 * Evaluation rule with (server/access-evaluation.ts): one RSA key pair,
 * made on first use and kept. Access fetches the public half from
 * `/access-evaluation/keys`; the private half is sealed (server/secrets/
 * sealed.ts).
 */
export const accessEvaluationKey = sqliteTable(
  "access_evaluation_key",
  {
    id: text("id").primaryKey(),
    kid: text("kid").notNull(),
    publicJwk: text("public_jwk").notNull(),
    privateJwkSealed: text("private_jwk_sealed").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    check(
      "access_evaluation_key_singleton_check",
      sql`${table.id} = 'current'`,
    ),
  ],
);
