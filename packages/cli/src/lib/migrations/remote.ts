/**
 * Production D1 migrations, the same for the gateway and every app:
 *
 *   1. a Time Travel bookmark, and the command that restores it (in the
 *      result, for the migration step's event and any later failure);
 *   2. `cf d1 migrations apply`, which keeps its own `d1_migrations` table.
 *
 * Callers run this before they upload new code, so a failed migration
 * leaves the version that is serving untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  applyRemoteMigrations,
  getD1Bookmark,
  restoreCommand,
} from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";

interface MigrateRemoteD1Options {
  cf: CfRunner;
  databaseId: string;
  /** For the rollback command printed with the bookmark. */
  accountId?: string;
  dir: string;
  /** Said as each step starts. */
  onProgress?: (message: string) => void;
}

interface MigrateRemoteD1Result {
  bookmark: string;
  /** Restores the bookmark: the caller shows it, and repeats it in a later failure. */
  rollbackCommand: string;
  applied: string[];
  /** The database had none of the migrations before: nothing to restore. */
  fresh: boolean;
}

export async function migrateRemoteD1({
  cf,
  databaseId,
  accountId,
  dir,
  onProgress,
}: MigrateRemoteD1Options): Promise<MigrateRemoteD1Result> {
  const nested = await hasNestedLayout(dir);
  const bookmark = await getD1Bookmark(cf, databaseId);
  const rollback = restoreCommand(databaseId, bookmark, accountId);

  const total = await countMigrations(dir, nested);
  try {
    const applied = await applyRemoteMigrations({
      cf,
      databaseId,
      dir,
      nested,
    });
    return {
      bookmark,
      rollbackCommand: rollback,
      applied,
      fresh: applied.length > 0 && applied.length === total,
    };
  } catch (error) {
    throw new EveryAppError(
      "MIGRATION_FAILED",
      [
        `Migrating the database failed: ${error instanceof Error ? error.message : String(error)}`,
        "Nothing was uploaded, so the version that is serving keeps running.",
        `To roll the database back to before this run: ${rollback}`,
      ].join("\n"),
    );
  }
}

/** The migrations in `dir`: `<tag>/migration.sql` each, or `*.sql` files. */
async function countMigrations(dir: string, nested: boolean): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (!nested) {
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql")).length;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await fs.access(path.join(dir, entry.name, "migration.sql"));
      count += 1;
    } catch {
      // Not a migration directory.
    }
  }
  return count;
}

/** drizzle-kit's newer layout keeps each migration in `<dir>/<tag>/migration.sql`. */
async function hasNestedLayout(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "meta") continue;
    try {
      await fs.access(path.join(dir, entry.name, "migration.sql"));
      return true;
    } catch {
      // Not a migration directory.
    }
  }
  return false;
}
