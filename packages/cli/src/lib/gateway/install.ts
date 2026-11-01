/**
 * `_everyapp_install`: the one row in the gateway's own D1 that records how
 * the CLI deployed it — account, zone, host, where app hosts live, resource
 * ids, the live release (and the checkout tree it was built from) and what
 * that deploy bound and published, and the public half of the gateway's
 * identity key, which the apps' deploys give their Workers to verify the
 * identities the gateway signs, and the deployment mode its first upload
 * set (self-hosted or hosted). The row is the source of truth for the live
 * release: any machine logged in to the account finds the Gateway and this
 * row (./discover.ts), and can redeploy or reconcile the gateway, or deploy
 * an app, from it; nothing about the install is kept anywhere else. A new
 * install writes it before its first upload (`live_version_id` null), so a
 * run that stops there resumes from it.
 */
import type { D1Database } from "@/lib/cf/d1";
import { EveryAppError } from "@/lib/errors";
import { CLI } from "@/lib/output/command";
import { textOrNull } from "@/lib/output/text";
import { parseReleaseOrigin, type ReleaseOrder, type ReleaseOrigin } from "./release";
import { DEPLOYMENT_MODES, type DeploymentMode } from "./secretsFile";

const CREATE_INSTALL_TABLE = `CREATE TABLE IF NOT EXISTS _everyapp_install (
  id TEXT PRIMARY KEY CHECK (id = 'install'),
  account_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  gateway_host TEXT NOT NULL,
  app_base_domain TEXT NOT NULL,
  oauth_kv_id TEXT NOT NULL,
  release_version TEXT NOT NULL,
  release_sha256 TEXT NOT NULL,
  release_schema INTEGER NOT NULL,
  release_committed_at INTEGER NOT NULL,
  source_tree_sha256 TEXT,
  live_version_id TEXT,
  live_domains TEXT NOT NULL DEFAULT '[]',
  live_app_workers TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  jwt_public_key TEXT,
  deployment_mode TEXT
)`;

/**
 * Columns added after the table's first shape, which CREATE TABLE IF NOT
 * EXISTS can't add: SQLite has no ADD COLUMN IF NOT EXISTS, so a write
 * looks them up first.
 */
const ADDED_COLUMNS = ["release_origin", "release_git_sha"] as const;

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
  releaseVersion: string;
  releaseSha256: string;
  /** Where the live release sits in the history. */
  releaseOrder: ReleaseOrder;
  /**
   * The tree hash of the checkout sources the live release was built from
   * (lib/gateway/checkoutRelease.ts); null when it wasn't built from one.
   */
  sourceTreeSha256: string | null;
  /**
   * Where the live release came from (lib/gateway/release.ts
   * `ReleaseOrigin`): a checkout, a GitHub release by tag, a URL or a
   * file. The rebind an app's deploy runs takes the same release again
   * from it (lib/gateway/liveRelease.ts). Null for a row written before
   * origins were recorded.
   */
  releaseOrigin: ReleaseOrigin | null;
  /** The commit the live release was built from, as its release.json says; null before it was recorded. */
  releaseGitSha: string | null;
  liveVersionId: string | null;
  liveDomains: string[];
  liveAppWorkers: string[];
  updatedAt: number;
  updatedBy: string | null;
  /**
   * The SPKI PEM of the gateway's identity key (`JWT_PUBLIC_KEY`), written
   * with the upload that set a new key pair. A write without one keeps the
   * one recorded.
   */
  jwtPublicKey: string | null;
  /**
   * The GATEWAY_DEPLOYMENT_MODE the first upload set (a secret, which
   * nothing reads back), written with that upload like `jwtPublicKey`; a
   * write without one keeps the one recorded. Null before the first upload.
   */
  deploymentMode: DeploymentMode | null;
}

function list(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

const mode = (value: unknown): DeploymentMode | null =>
  (DEPLOYMENT_MODES as readonly unknown[]).includes(value)
    ? (value as DeploymentMode)
    : null;

/** Thrown when an install row is required but this gateway has none. */
export function notDeployedByEveryapp(): EveryAppError {
  return new EveryAppError(
    "GATEWAY_NOT_INSTALLED",
    "The Gateway's install didn't finish\nSetup stopped before it recorded the install.",
    { rerun: `${CLI} setup`, rerunNote: "asks for the hostname again" },
  );
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
    releaseVersion: String(row["release_version"]),
    releaseSha256: String(row["release_sha256"]),
    releaseOrder: {
      schema: Number(row["release_schema"]),
      committedAt: Number(row["release_committed_at"]),
    },
    sourceTreeSha256: textOrNull(row["source_tree_sha256"]),
    releaseOrigin: parseReleaseOrigin(row["release_origin"]),
    releaseGitSha: textOrNull(row["release_git_sha"]),
    liveVersionId: textOrNull(row["live_version_id"]),
    liveDomains: list(row["live_domains"]),
    liveAppWorkers: list(row["live_app_workers"]),
    updatedAt: Number(row["updated_at"]),
    updatedBy: textOrNull(row["updated_by"]),
    jwtPublicKey: textOrNull(row["jwt_public_key"]),
    deploymentMode: mode(row["deployment_mode"]),
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
    record.releaseVersion,
    record.releaseSha256,
    record.releaseOrder.schema,
    record.releaseOrder.committedAt,
    record.sourceTreeSha256,
    record.liveVersionId,
    JSON.stringify(record.liveDomains),
    JSON.stringify(record.liveAppWorkers),
    record.updatedAt,
    record.updatedBy,
    record.jwtPublicKey,
    record.deploymentMode,
    record.releaseOrigin ? JSON.stringify(record.releaseOrigin) : null,
    record.releaseGitSha,
  ];
  const [, columns = []] = await db.run([
    { sql: CREATE_INSTALL_TABLE },
    { sql: "PRAGMA table_info(_everyapp_install)" },
  ]);
  const have = new Set(columns.map((column) => String(column["name"])));
  const missing = ADDED_COLUMNS.filter((column) => !have.has(column));
  if (missing.length > 0) {
    await db.run(
      missing.map((column) => ({ sql: `ALTER TABLE _everyapp_install ADD COLUMN ${column} TEXT` })),
    );
  }
  await db.run([
    {
      sql: `INSERT INTO _everyapp_install (id, account_id, zone_id, zone_name, gateway_host,
  app_base_domain, oauth_kv_id, release_version, release_sha256, release_schema,
  release_committed_at, source_tree_sha256, live_version_id, live_domains,
  live_app_workers, updated_at, updated_by, jwt_public_key, deployment_mode,
  release_origin, release_git_sha)
VALUES ('install', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
ON CONFLICT(id) DO UPDATE SET account_id = excluded.account_id,
  zone_id = excluded.zone_id, zone_name = excluded.zone_name,
  gateway_host = excluded.gateway_host, app_base_domain = excluded.app_base_domain,
  oauth_kv_id = excluded.oauth_kv_id, release_version = excluded.release_version,
  release_sha256 = excluded.release_sha256, release_schema = excluded.release_schema,
  release_committed_at = excluded.release_committed_at,
  source_tree_sha256 = excluded.source_tree_sha256,
  live_version_id = excluded.live_version_id, live_domains = excluded.live_domains,
  live_app_workers = excluded.live_app_workers, updated_at = excluded.updated_at,
  updated_by = excluded.updated_by,
  jwt_public_key = COALESCE(excluded.jwt_public_key, _everyapp_install.jwt_public_key),
  deployment_mode = COALESCE(excluded.deployment_mode, _everyapp_install.deployment_mode),
  release_origin = excluded.release_origin, release_git_sha = excluded.release_git_sha`,
      params: values,
    },
  ]);
}
