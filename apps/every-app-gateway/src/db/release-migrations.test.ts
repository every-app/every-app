import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `everyapp gateway deploy` applies migrations before it uploads the new
 * code, so the gateway that is serving keeps running against the migrated
 * database: a migration may add, never take away. A migration that drops or
 * renames a table or column has to wait one release, until no live code
 * reads it, and say so with `-- everyapp:contract <release it follows>`.
 *
 * Migrations from before the deploy order changed are not checked.
 */
const FIRST_CHECKED_MIGRATION = 27;
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

  it.each(checked)("%s only expands the schema", (file) => {
    const sql = fs.readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    if (/^--\s*everyapp:contract\s+\S+/m.test(sql)) return;
    expect(
      withoutComments(sql).match(CONTRACTING)?.[0] ?? null,
      `${file} drops or renames: mark it "-- everyapp:contract <release>" once no live code uses what it removes`,
    ).toBeNull();
  });
});
