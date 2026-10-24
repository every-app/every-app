import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `everyapp setup` applies migrations before it uploads the new
 * code, so the gateway that is serving keeps running against the migrated
 * database: a migration may add, never take away. A migration that drops or
 * renames a table or column has to wait one release, until no live code
 * reads it, and say so with `-- everyapp:contract <release it follows>`.
 *
 * Every migration is checked, the generated baseline included (it only
 * creates).
 *
 * A migration a live gateway has applied is frozen: `setup` tracks applied
 * migrations by file name in D1's `d1_migrations` table, so renaming or
 * regenerating one makes setup replay it from the top ("table `accounts`
 * already exists"). Schema changes append a new file; when one ships to
 * everyapp.team, add it to SHIPPED_MIGRATIONS.
 */
const SHIPPED_MIGRATIONS: Record<string, string> = {
  // everyapp.team, release 0.2.0 (31a85593, 2026-10-16)
  "0000_lyrical_wild_child.sql":
    "80937eb7b5570112ac24ad01a178491f42c4fb2f9126411ca44ce2a38e562ecf",
  // everyapp.team, applied by 2026-10-23 (#347, #352)
  "0001_deploy_job_source.sql":
    "f170fde008780207f57d19219f58f2974f5e1a665dd36b6289bf4aa317bcc109",
  "0002_app_email_config.sql":
    "adbeaccf4cfd4e51a129aad721e0c8811f0438281a0aa63002a32bdcf4870f45",
  // 0004_app_secret_names.sql: add its hash once everyapp.team has applied it.
};
const FIRST_CHECKED_MIGRATION = 0;
const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));
const CONTRACTING = /\bDROP\s+(TABLE|COLUMN)\b|\bRENAME\b/i;

function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

describe("gateway migrations", () => {
  const checked = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .filter((file) => Number.parseInt(file, 10) >= FIRST_CHECKED_MIGRATION);

  it.each(Object.entries(SHIPPED_MIGRATIONS))(
    "%s is unchanged since it shipped",
    (file, sha256) => {
      const path = `${MIGRATIONS_DIR}/${file}`;
      expect(
        fs.existsSync(path),
        `${file} was applied to a live gateway: keep it and append a new migration instead`,
      ).toBe(true);
      expect(
        createHash("sha256").update(fs.readFileSync(path)).digest("hex"),
        `${file} was applied to a live gateway: revert the edit and append a new migration instead`,
      ).toBe(sha256);
    },
  );

  it.each(checked)("%s only expands the schema", (file) => {
    const sql = fs.readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    if (/^--\s*everyapp:contract\s+\S+/m.test(sql)) return;
    expect(
      withoutComments(sql).match(CONTRACTING)?.[0] ?? null,
      `${file} drops or renames: mark it "-- everyapp:contract <release>" once no live code uses what it removes`,
    ).toBeNull();
  });
});
