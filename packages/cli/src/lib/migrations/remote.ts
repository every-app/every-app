/**
 * Production D1 migrations, the same for the gateway and every app:
 *
 *   1. a Time Travel bookmark, printed with the command that restores it;
 *   2. once per database, carry drizzle-kit's history over to cf's;
 *   3. `cf d1 migrations apply`.
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
  type D1Database,
} from "@/lib/cf/d1";
import type { CfRunner } from "@/lib/cf/runner";
import { EveryAppError } from "@/lib/errors";

/** drizzle-kit's journal entry: a migration's tag and when it was generated. */
export interface JournalEntry {
  tag: string;
  when: number;
}

/** cf's bookkeeping table, created exactly as `cf d1 migrations apply` does. */
const CREATE_D1_MIGRATIONS = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/**
 * A database drizzle-kit migrated records what ran in
 * `__drizzle_migrations`; cf reads `d1_migrations` and would run everything
 * again. Before cf's first run, mark each migration drizzle applied, by
 * drizzle's own rule: every journal entry generated no later than the newest
 * one it recorded. Does nothing once `d1_migrations` has rows. Returns the
 * names marked.
 */
export async function backfillD1Migrations({
  db,
  journal,
  nameFor,
}: {
  db: D1Database;
  journal: readonly JournalEntry[];
  /** The file name cf knows a migration by, e.g. `0000_init.sql`. */
  nameFor: (tag: string) => string;
}): Promise<string[]> {
  const [tables = []] = await db.run([
    {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('__drizzle_migrations', 'd1_migrations')",
    },
  ]);
  const existing = new Set(tables.map((row) => row["name"]));
  if (!existing.has("__drizzle_migrations")) return [];
  if (existing.has("d1_migrations")) {
    const [[counted] = []] = await db.run([
      { sql: "SELECT COUNT(*) AS count FROM d1_migrations" },
    ]);
    if (Number(counted?.["count"] ?? 0) > 0) return [];
  }

  const [[newest] = []] = await db.run([
    { sql: "SELECT MAX(created_at) AS latest FROM __drizzle_migrations" },
  ]);
  const latest = Number(newest?.["latest"]);
  if (newest?.["latest"] === null || !Number.isFinite(latest)) return [];

  const applied = journal
    .filter((entry) => entry.when <= latest)
    .map((entry) => nameFor(entry.tag));
  if (applied.length === 0) return [];
  await db.run([
    { sql: CREATE_D1_MIGRATIONS },
    ...applied.map((name) => ({
      sql: "INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)",
      params: [name],
    })),
  ]);
  return applied;
}

interface MigrateRemoteD1Options {
  cf: CfRunner;
  db: D1Database;
  databaseId: string;
  /** For the rollback command printed with the bookmark. */
  accountId?: string;
  dir: string;
  /** drizzle-kit's journal, when drizzle-kit may have migrated it before. */
  journal?: readonly JournalEntry[];
  /** Said as each step starts. */
  onProgress?: (message: string) => void;
}

interface MigrateRemoteD1Result {
  bookmark: string;
  backfilled: string[];
  applied: string[];
}

export async function migrateRemoteD1({
  cf,
  db,
  databaseId,
  accountId,
  dir,
  journal,
  onProgress,
}: MigrateRemoteD1Options): Promise<MigrateRemoteD1Result> {
  const nested = await hasNestedLayout(dir);
  const bookmark = await getD1Bookmark(cf, databaseId);
  const rollback = restoreCommand(databaseId, bookmark, accountId);
  onProgress?.(
    `Bookmarked the database before migrating. To roll it back: ${rollback}`,
  );

  const backfilled = journal
    ? await backfillD1Migrations({
        db,
        journal,
        nameFor: (tag) => (nested ? `${tag}/migration.sql` : `${tag}.sql`),
      })
    : [];
  if (backfilled.length > 0) {
    onProgress?.(
      `Recorded ${backfilled.length} migration${backfilled.length === 1 ? "" : "s"} drizzle-kit had applied, so cf won't run them again.`,
    );
  }

  try {
    const applied = await applyRemoteMigrations({
      cf,
      databaseId,
      dir,
      nested,
    });
    return { bookmark, backfilled, applied };
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

/** The journal drizzle-kit keeps next to an app's migrations, if any. */
export async function readDrizzleJournal(
  dir: string,
): Promise<JournalEntry[] | undefined> {
  try {
    const journal = JSON.parse(
      await fs.readFile(path.join(dir, "meta", "_journal.json"), "utf8"),
    ) as { entries?: Array<{ tag?: unknown; when?: unknown }> };
    return (journal.entries ?? []).flatMap((entry) =>
      typeof entry.tag === "string" && typeof entry.when === "number"
        ? [{ tag: entry.tag, when: entry.when }]
        : [],
    );
  } catch {
    return undefined;
  }
}
