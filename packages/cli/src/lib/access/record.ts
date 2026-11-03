import type { D1Database } from "@/lib/cf/d1";

/**
 * Leaving Access off is a choice someone made, kept in the Gateway's D1
 * (`_everyapp_access_off`, one row): `setup --no-access`, No to setup's
 * question, or `access off`. Unattended setup reads it and leaves Access
 * off instead of putting it back on; `access on` clears it.
 */
const CREATE_OFF_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_access_off (
  id TEXT PRIMARY KEY CHECK (id = 'access'),
  reason TEXT NOT NULL,
  chosen_at INTEGER NOT NULL
)`;

/** How Access was left off: setup's flag, No to its question, or `access off`. */
export type AccessOffReason = "no-access" | "declined" | "access-off";

/** The choice to leave Access off, or null when nobody made it (or `access on` ran since). */
export async function readAccessOffChoice(db: D1Database): Promise<AccessOffReason | null> {
  const [tables = []] = await db.run([
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_everyapp_access_off'" },
  ]);
  if (tables.length === 0) return null;
  const [rows = []] = await db.run([{ sql: "SELECT reason FROM _everyapp_access_off WHERE id = 'access'" }]);
  const reason = rows[0]?.["reason"];
  return reason === undefined ? null : (String(reason) as AccessOffReason);
}

/** Remember that Access was left off on purpose. */
export async function writeAccessOffChoice(db: D1Database, reason: AccessOffReason): Promise<void> {
  await db.run([
    { sql: CREATE_OFF_TABLE },
    {
      sql: `INSERT INTO _everyapp_access_off (id, reason, chosen_at) VALUES ('access', ?1, ?2)
ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, chosen_at = excluded.chosen_at`,
      params: [reason, Date.now()],
    },
  ]);
}

/** Forget the choice: Access is on again. */
export async function clearAccessOffChoice(db: D1Database): Promise<void> {
  await db.run([{ sql: CREATE_OFF_TABLE }, { sql: "DELETE FROM _everyapp_access_off WHERE id = 'access'" }]);
}
