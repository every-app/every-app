/**
 * `_everyapp_install`: the one row in the gateway's own D1 that records how
 * the CLI deployed it — account, zone, host, where app hosts live, resource
 * ids, the live release and what that deploy bound and published, and the
 * public half of the gateway's identity key, which app deploys give their
 * Workers to verify the identities the gateway signs. The Cloudflare account
 * is the source of truth: any machine logged in to it can redeploy or
 * reconcile the gateway, or deploy an app, from this row, and
 * `~/.everyapp/installs.json` is only a cache of it.
 */
import type { D1Database } from "@/lib/cf/d1";
import type { ReleaseOrder } from "./release";

const CREATE_INSTALL_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_install (
  id TEXT PRIMARY KEY CHECK (id = 'install'),
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  gateway_host TEXT NOT NULL,
  app_base_domain TEXT NOT NULL,
  oauth_kv_id TEXT NOT NULL,
  deploy_kv_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  release_sha256 TEXT NOT NULL,
  live_version_id TEXT,
  live_domains TEXT NOT NULL DEFAULT '[]',
  live_app_workers TEXT NOT NULL DEFAULT '[]',
  schema_version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  release_schema INTEGER,
  release_built_at INTEGER,
  jwt_public_key TEXT
)`;

// Columns added after the table first shipped, for tables created before.
const ADDED_COLUMNS = [
  ["release_schema", "INTEGER"],
  ["release_built_at", "INTEGER"],
  ["jwt_public_key", "TEXT"],
] as const;

export interface InstallRecord {
  accountId: string;
  zoneId: string;
  zoneName: string;
  gatewayHost: string;
  /**
   * Apps live one label below it, each a Workers Custom Domain on the
   * gateway Worker; the gateway host for now.
   */
  appBaseDomain: string;
  oauthKvId: string;
  deployKvId: string;
  releaseVersion: string;
  releaseSha256: string;
  /** Where the live release sits in the history; null on rows from before it was kept. */
  releaseOrder: ReleaseOrder | null;
  liveVersionId: string | null;
  liveDomains: string[];
  liveAppWorkers: string[];
  updatedAt: number;
  updatedBy: string | null;
  /**
   * The SPKI PEM of the gateway's identity key (`JWT_PUBLIC_KEY`), written
   * when the CLI generates the key pair at the gateway's first deploy. A
   * write without one keeps the one recorded.
   */
  jwtPublicKey: string | null;
}

function list(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The install row, or null before the CLI first deployed this gateway. */
export async function readInstall(
  db: D1Database,
): Promise<InstallRecord | null> {
  const [tables = []] = await db.run([
    {
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_everyapp_install'",
    },
  ]);
  if (tables.length === 0) return null;
  const [rows = []] = await db.run([
    { sql: "SELECT * FROM _everyapp_install WHERE id = 'install'" },
  ]);
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: String(row["account_id"]),
    zoneId: String(row["zone_id"]),
    zoneName: String(row["zone_name"]),
    gatewayHost: String(row["gateway_host"]),
    appBaseDomain: String(row["app_base_domain"]),
    oauthKvId: String(row["oauth_kv_id"]),
    deployKvId: String(row["deploy_kv_id"]),
    releaseVersion: String(row["release_version"]),
    releaseSha256: String(row["release_sha256"]),
    releaseOrder:
      typeof row["release_schema"] === "number" &&
      typeof row["release_built_at"] === "number"
        ? {
            schema: row["release_schema"],
            builtAt: row["release_built_at"],
          }
        : null,
    liveVersionId:
      row["live_version_id"] === null ? null : String(row["live_version_id"]),
    liveDomains: list(row["live_domains"]),
    liveAppWorkers: list(row["live_app_workers"]),
    updatedAt: Number(row["updated_at"]),
    updatedBy: row["updated_by"] === null ? null : String(row["updated_by"]),
    jwtPublicKey:
      typeof row["jwt_public_key"] === "string" && row["jwt_public_key"]
        ? row["jwt_public_key"]
        : null,
  };
}

export async function writeInstall(
  db: D1Database,
  record: InstallRecord,
): Promise<void> {
  const values = [
    record.accountId,
    record.zoneId,
    record.zoneName,
    record.gatewayHost,
    record.appBaseDomain,
    record.oauthKvId,
    record.deployKvId,
    record.releaseVersion,
    record.releaseSha256,
    record.liveVersionId,
    JSON.stringify(record.liveDomains),
    JSON.stringify(record.liveAppWorkers),
    record.updatedAt,
    record.updatedBy,
    record.releaseOrder?.schema ?? null,
    record.releaseOrder?.builtAt ?? null,
    record.jwtPublicKey,
  ];
  await ensureInstallTable(db);
  await db.run([
    {
      sql: `INSERT INTO _everyapp_install (id, account_id, zone_id, zone_name, gateway_host,
  app_base_domain, oauth_kv_id, deploy_kv_id, release_version, release_sha256,
  live_version_id, live_domains, live_app_workers, updated_at, updated_by,
  release_schema, release_built_at, jwt_public_key)
VALUES ('install', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id,
  zone_id = excluded.zone_id, zone_name = excluded.zone_name,
  gateway_host = excluded.gateway_host, app_base_domain = excluded.app_base_domain,
  oauth_kv_id = excluded.oauth_kv_id, deploy_kv_id = excluded.deploy_kv_id,
  release_version = excluded.release_version, release_sha256 = excluded.release_sha256,
  live_version_id = excluded.live_version_id, live_domains = excluded.live_domains,
  live_app_workers = excluded.live_app_workers, updated_at = excluded.updated_at,
  updated_by = excluded.updated_by, release_schema = excluded.release_schema,
  release_built_at = excluded.release_built_at,
  jwt_public_key = COALESCE(excluded.jwt_public_key, _everyapp_install.jwt_public_key)`,
      params: values,
    },
  ]);
}

/** The table, with the columns added since it first shipped. */
async function ensureInstallTable(db: D1Database): Promise<void> {
  const [, columns = []] = await db.run([
    { sql: CREATE_INSTALL_TABLE },
    { sql: `PRAGMA table_info("_everyapp_install")` },
  ]);
  const present = new Set(columns.map((column) => String(column["name"])));
  const missing = ADDED_COLUMNS.filter(([name]) => !present.has(name));
  if (missing.length > 0) {
    await db.run(
      missing.map(([name, type]) => ({
        sql: `ALTER TABLE _everyapp_install ADD COLUMN ${name} ${type}`,
      })),
    );
  }
}
