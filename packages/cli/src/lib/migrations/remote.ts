/**
 * Production D1 migrations, the same for the gateway and every app:
 *
 *   1. `cf d1 migrations list`: the migrations still to apply (none: done);
 *   2. unless the database had none of them yet, a Time Travel bookmark,
 *      recorded as the database's restore point in the Gateway's registry
 *      (lib/gateway/restorePoints.ts) with those migrations, who ran them
 *      and when: `everyapp db restore` puts the database back to it;
 *   3. `cf d1 migrations apply`, which keeps its own `d1_migrations` table.
 *
 * Callers run this before they upload new code, so a failed migration
 * leaves the version that is serving untouched.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { cfWhoami } from "@/lib/cf/account";
import {
  applyRemoteMigrations,
  getD1Bookmark,
  listPendingRemoteMigrations,
  restoreCommand,
  type D1Database,
} from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError, type Rollback } from "@/lib/errors";
import { deployerFor } from "@/lib/gateway/registry";
import {
  forgetRestorePoint,
  recordRestorePoint,
} from "@/lib/gateway/restorePoints";

interface MigrateRemoteD1Options {
  cf: CfRunner;
  databaseId: string;
  /** The database's account: who the restore point names, and cf's restore command. */
  accountId: string;
  dir: string;
  /** The Gateway's registry, where the restore point is recorded. */
  registry: D1Database;
  /** Whose database it is (`gateway`, `app:<worker>`: lib/gateway/restorePoints.ts). */
  target: string;
  /** How a person restores it: `everyapp db restore`, with what it needs. */
  restoreCommand: string;
}

interface MigrateRemoteD1Result {
  applied: string[];
  /** The database had none of the migrations before: nothing to restore. */
  fresh: boolean;
  /** The restore point saved before applying them, if one was. */
  rollback: Rollback | null;
}

export async function migrateRemoteD1({
  cf,
  databaseId,
  accountId,
  dir,
  registry,
  target,
  restoreCommand: restore,
}: MigrateRemoteD1Options): Promise<MigrateRemoteD1Result> {
  const nested = await hasNestedLayout(dir);
  const pending = await listPendingRemoteMigrations({ cf, databaseId, dir, nested });
  if (pending.length === 0) return { applied: [], fresh: false, rollback: null };

  const fresh = pending.length === (await countMigrations(dir, nested));
  let rollback: Rollback | null = null;
  if (fresh) {
    // A restore point of a database this one replaced is no way back.
    await forgetRestorePoint(registry, target);
  } else {
    const bookmark = await getD1Bookmark(cf, databaseId);
    const { email } = await cfWhoami(cf);
    await recordRestorePoint(registry, {
      target,
      databaseId,
      bookmark,
      migrations: pending,
      createdAt: Date.now(),
      createdBy: deployerFor(email, accountId).actor,
    });
    rollback = {
      restoreCommand: restore,
      rollbackCommand: restoreCommand(databaseId, bookmark, accountId),
    };
  }

  try {
    const applied = await applyRemoteMigrations({ cf, databaseId, dir, nested });
    return { applied, fresh, rollback };
  } catch (error) {
    throw new EveryAppError(
      "MIGRATION_FAILED",
      [
        "Database migration failed",
        error instanceof Error ? error.message : String(error),
        "Nothing was uploaded; the version that's serving keeps running.",
        ...(rollback ? [`To roll the database back to before this run: ${rollback.restoreCommand}`] : []),
      ].join("\n"),
      {
        data: {
          fix: "correct the migration",
          ...(rollback ? { rollbackCommand: rollback.rollbackCommand } : {}),
        },
      },
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
