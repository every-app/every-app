/**
 * What `access on` last wrote to the Gateway's Access settings, kept in
 * the Gateway's own D1 beside the install row (`_everyapp_access`, one
 * row): the team domain and the two AUD tags. A Worker's secret values
 * can't be read back, so this record is how a rerun, or `access show`,
 * knows the settings still name the applications in front of the Gateway
 * (an application recreated in the dashboard has a new AUD tag, and the
 * old one locks everyone out) without writing a new Worker version every
 * time. `access off` clears it.
 */
import type { D1Database, D1Statement } from "@/lib/cf/d1";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_access (
  id TEXT PRIMARY KEY CHECK (id = 'access'),
  team_domain TEXT NOT NULL,
  gateway_aud TEXT NOT NULL,
  apps_aud TEXT NOT NULL,
  written_at INTEGER NOT NULL
)`;

/** The values written: `CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `_AUD` and `_APPS_AUD`. */
interface AccessSettingsRecord {
  teamDomain: string;
  gatewayAud: string;
  appsAud: string;
  writtenAt: number;
}

/** The record, or null when `access on` never wrote one. Reads only: `status` calls it too. */
export async function readAccessSettingsRecord(db: D1Database): Promise<AccessSettingsRecord | null> {
  const [tables = []] = await db.run([
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_everyapp_access'" },
  ]);
  if (tables.length === 0) return null;
  const [rows = []] = await db.run([
    { sql: "SELECT team_domain, gateway_aud, apps_aud, written_at FROM _everyapp_access WHERE id = 'access'" },
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    teamDomain: String(row["team_domain"]),
    gatewayAud: String(row["gateway_aud"]),
    appsAud: String(row["apps_aud"]),
    writtenAt: Number(row["written_at"]),
  };
}

/** Record what was written; `also` rides in the same batch (the `access.changed` event). */
export async function writeAccessSettingsRecord(
  db: D1Database,
  record: AccessSettingsRecord,
  also: readonly D1Statement[] = [],
): Promise<void> {
  await db.run([
    { sql: CREATE_TABLE },
    {
      sql: `INSERT INTO _everyapp_access (id, team_domain, gateway_aud, apps_aud, written_at)
VALUES ('access', ?1, ?2, ?3, ?4)
ON CONFLICT(id) DO UPDATE SET team_domain = excluded.team_domain,
  gateway_aud = excluded.gateway_aud, apps_aud = excluded.apps_aud, written_at = excluded.written_at`,
      params: [record.teamDomain, record.gatewayAud, record.appsAud, record.writtenAt],
    },
    ...also,
  ]);
}

/** Forget what was written; `also` rides in the same batch (the `access.changed` event). */
export async function clearAccessSettingsRecord(db: D1Database, also: readonly D1Statement[] = []): Promise<void> {
  await db.run([{ sql: CREATE_TABLE }, { sql: "DELETE FROM _everyapp_access WHERE id = 'access'" }, ...also]);
}

/** Whether the settings as recorded name this team and these applications. */
export function settingsNameApplications(
  record: AccessSettingsRecord,
  current: { teamDomain: string; gatewayAud: string; appsAud: string },
): boolean {
  return (
    record.teamDomain === current.teamDomain &&
    record.gatewayAud === current.gatewayAud &&
    record.appsAud === current.appsAud
  );
}

/**
 * Leaving Access off is a choice someone made, kept beside the record
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
