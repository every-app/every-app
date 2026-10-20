/**
 * Restore points: `_everyapp_restore_points` in the Gateway's own D1, one
 * row per database a deploy migrates (the Gateway's, or an app's), written
 * by the CLI like the lease table (it isn't in the Gateway's schema).
 *
 * Before a deploy, `setup` or a Gateway upgrade applies migrations to a
 * database that had some already, it takes a Time Travel bookmark and
 * records it here with the migrations about to run, who ran them and when
 * (lib/migrations/remote.ts). `everyapp db restore` puts the database back
 * to it, then forgets it. A database that was empty gets none: there is
 * nothing to go back to.
 *
 * The Gateway's own row is written after its bookmark, so restoring the
 * Gateway's database takes the row with it.
 */
import { appLeaseId, GATEWAY_LEASE_ID } from "./lease";
import type { D1Database, D1Statement } from "@/lib/cf/d1";

const CREATE_TABLE: D1Statement = {
  sql: `CREATE TABLE IF NOT EXISTS _everyapp_restore_points (
  target TEXT PRIMARY KEY,
  database_id TEXT NOT NULL,
  bookmark TEXT NOT NULL,
  migrations TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL
)`,
};

/** The Gateway's database, as a restore point's target: its deploy lease's id. */
export const GATEWAY_RESTORE_TARGET = GATEWAY_LEASE_ID;

/** An app's database, as a restore point's target: its deploy lease's id. */
export const appRestoreTarget = appLeaseId;

export interface RestorePoint {
  /** `gateway`, or `app:<workerName>`. */
  target: string;
  databaseId: string;
  bookmark: string;
  /** The migrations the run went on to apply, in order. */
  migrations: string[];
  createdAt: number;
  /** The deployer's actor: the Cloudflare login's email, or `api-token:<account id>`. */
  createdBy: string;
}

/** Record `point` as its target's restore point, replacing the one before. */
export async function recordRestorePoint(
  db: D1Database,
  point: RestorePoint,
): Promise<void> {
  await db.run([
    CREATE_TABLE,
    {
      sql: `INSERT INTO _everyapp_restore_points (target, database_id, bookmark, migrations, created_at, created_by)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT (target) DO UPDATE SET database_id = excluded.database_id, bookmark = excluded.bookmark,
  migrations = excluded.migrations, created_at = excluded.created_at, created_by = excluded.created_by`,
      params: [
        point.target,
        point.databaseId,
        point.bookmark,
        JSON.stringify(point.migrations),
        point.createdAt,
        point.createdBy,
      ],
    },
  ]);
}

/** The restore point last recorded for `target`, if it has one. */
export async function readRestorePoint(
  db: D1Database,
  target: string,
): Promise<RestorePoint | null> {
  const [, rows = []] = await db.run([
    CREATE_TABLE,
    {
      sql: "SELECT target, database_id, bookmark, migrations, created_at, created_by FROM _everyapp_restore_points WHERE target = ?",
      params: [target],
    },
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    target: String(row["target"]),
    databaseId: String(row["database_id"]),
    bookmark: String(row["bookmark"]),
    migrations: (JSON.parse(String(row["migrations"])) as unknown[]).map(String),
    createdAt: Number(row["created_at"]),
    createdBy: String(row["created_by"]),
  };
}

/** `target` has no restore point any more: it was restored, or its database started empty. */
export async function forgetRestorePoint(
  db: D1Database,
  target: string,
): Promise<void> {
  await db.run([
    CREATE_TABLE,
    { sql: "DELETE FROM _everyapp_restore_points WHERE target = ?", params: [target] },
  ]);
}
