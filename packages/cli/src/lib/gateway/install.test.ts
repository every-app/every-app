import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "@/test/sqliteD1";
import { readInstall, writeInstall, type InstallRecord } from "./install";

const RECORD: InstallRecord = {
  accountId: "acct",
  zoneId: "zone",
  zoneName: "example.com",
  gatewayHost: "apps.example.com",
  appBaseDomain: "apps.example.com",
  oauthKvId: "kv",
  releaseVersion: "0.3.0-rc.4",
  releaseSha256: "a".repeat(64),
  releaseOrder: { schema: 1, committedAt: 1_700_000_000_000 },
  sourceTreeSha256: null,
  releaseOrigin: { kind: "github", repo: "every-app/every-app", tag: "gateway-v0.3.0-rc.4" },
  releaseGitSha: "302315f511eb18f26c34e7db2d07ecc305d903b1",
  liveVersionId: "v1",
  liveDomains: ["apps.example.com"],
  liveAppWorkers: [],
  updatedAt: 1,
  updatedBy: "test",
  jwtPublicKey: null,
  deploymentMode: "self_hosted",
};

/** The table as installs before origins were recorded created it. */
const OLD_TABLE = `CREATE TABLE _everyapp_install (
  id TEXT PRIMARY KEY CHECK (id = 'install'),
  account_id TEXT NOT NULL, zone_id TEXT NOT NULL, zone_name TEXT NOT NULL,
  gateway_host TEXT NOT NULL, app_base_domain TEXT NOT NULL, oauth_kv_id TEXT NOT NULL,
  release_version TEXT NOT NULL, release_sha256 TEXT NOT NULL, release_schema INTEGER NOT NULL,
  release_committed_at INTEGER NOT NULL, source_tree_sha256 TEXT, live_version_id TEXT,
  live_domains TEXT NOT NULL DEFAULT '[]', live_app_workers TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL, updated_by TEXT, jwt_public_key TEXT, deployment_mode TEXT
)`;

describe("the install row's release origin", () => {
  it("records where the live release came from and which commit built it", async () => {
    const db = createSqliteD1();
    await writeInstall(db, RECORD);
    await expect(readInstall(db)).resolves.toMatchObject({
      releaseOrigin: RECORD.releaseOrigin,
      releaseGitSha: RECORD.releaseGitSha,
    });
    await writeInstall(db, { ...RECORD, releaseOrigin: { kind: "checkout" }, releaseGitSha: "abc-dirty" });
    await expect(readInstall(db)).resolves.toMatchObject({
      releaseOrigin: { kind: "checkout" },
      releaseGitSha: "abc-dirty",
    });
  });

  it("adds its columns to a row written before they existed, which reads as unknown until then", async () => {
    const db = createSqliteD1();
    await db.run([
      { sql: OLD_TABLE },
      {
        sql: `INSERT INTO _everyapp_install (id, account_id, zone_id, zone_name, gateway_host, app_base_domain,
  oauth_kv_id, release_version, release_sha256, release_schema, release_committed_at, updated_at)
VALUES ('install', 'acct', 'zone', 'example.com', 'apps.example.com', 'apps.example.com', 'kv', '0.2.0', '${"b".repeat(64)}', 1, 1, 1)`,
      },
    ]);
    await expect(readInstall(db)).resolves.toMatchObject({
      releaseVersion: "0.2.0",
      releaseOrigin: null,
      releaseGitSha: null,
    });
    await writeInstall(db, RECORD);
    await expect(readInstall(db)).resolves.toMatchObject({
      releaseVersion: "0.3.0-rc.4",
      releaseOrigin: RECORD.releaseOrigin,
    });
  });

  it("reads an origin it can't parse as unknown rather than failing the row", async () => {
    const db = createSqliteD1();
    await writeInstall(db, RECORD);
    await db.run([{ sql: "UPDATE _everyapp_install SET release_origin = '{\"kind\":\"ftp\"}'" }]);
    await expect(readInstall(db)).resolves.toMatchObject({ releaseOrigin: null });
  });
});
