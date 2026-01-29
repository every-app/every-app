import { randomUUID } from "node:crypto";
import { queryD1Database } from "@/lib/cloudflare-d1-queries";
import type { GatewayDbConnection } from "./connection";

/**
 * Options for upserting a user app record
 */
interface UpsertUserAppOptions {
  appId: string;
  appUrl: string;
  name: string;
  description: string;
  devUrl?: string;
  isDefault?: boolean;
}

/**
 * Result of an upsert operation
 */
interface UpsertResult {
  created: boolean;
}

type AppRecord = {
  id: string;
  dev_url: string | null;
  is_default: number;
};

/**
 * Fetch an app record by app slug (app_id)
 */
export async function getAppCatalogByAppId(
  db: GatewayDbConnection,
  appId: string,
): Promise<AppRecord | null> {
  const records = await queryD1Database<AppRecord>(
    db.accountId,
    db.databaseId,
    "SELECT id, dev_url, is_default FROM apps WHERE app_id = ?",
    [appId],
  );

  return records[0] ?? null;
}

/**
 * Ensure an app exists in the apps catalog and return its ID
 */
export async function upsertAppCatalog(
  db: GatewayDbConnection,
  options: UpsertUserAppOptions,
): Promise<string> {
  const existingApp = await getAppCatalogByAppId(db, options.appId);
  const now = Date.now();
  const isDefault = options.isDefault ?? Boolean(existingApp?.is_default ?? 0);

  if (existingApp) {
    const devUrl = options.devUrl ?? existingApp.dev_url ?? null;
    await queryD1Database(
      db.accountId,
      db.databaseId,
      "UPDATE apps SET name = ?, description = ?, app_url = ?, dev_url = ?, is_default = ?, updated_at = ? WHERE id = ?",
      [
        options.name,
        options.description,
        options.appUrl,
        devUrl,
        isDefault ? 1 : 0,
        now,
        existingApp.id,
      ],
    );

    return existingApp.id;
  }

  const appRecordId = randomUUID();
  await queryD1Database(
    db.accountId,
    db.databaseId,
    "INSERT INTO apps (id, app_id, name, description, app_url, dev_url, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      appRecordId,
      options.appId,
      options.name,
      options.description,
      options.appUrl,
      options.devUrl ?? null,
      isDefault ? 1 : 0,
      now,
      now,
    ],
  );

  return appRecordId;
}

/**
 * Check if a user already has access to an app
 */
async function userAppAccessExists(
  db: GatewayDbConnection,
  userId: string,
  appId: string,
): Promise<boolean> {
  const existingRecords = await queryD1Database<{ id: string }>(
    db.accountId,
    db.databaseId,
    "SELECT id FROM user_app_access WHERE user_id = ? AND app_id = ?",
    [userId, appId],
  );

  return existingRecords.length > 0;
}

/**
 * Insert a user access record if it doesn't already exist
 * Ensures the app is registered in the apps catalog first
 * @returns Whether a new access record was created
 */
export async function upsertUserAppAccess(
  db: GatewayDbConnection,
  userId: string,
  appRecordId: string,
): Promise<UpsertResult> {
  const exists = await userAppAccessExists(db, userId, appRecordId);

  if (exists) {
    return { created: false };
  }

  const now = Date.now();
  const recordId = randomUUID();

  await queryD1Database(
    db.accountId,
    db.databaseId,
    "INSERT INTO user_app_access (id, user_id, app_id, granted_at, granted_by) VALUES (?, ?, ?, ?, ?)",
    [recordId, userId, appRecordId, now, null],
  );

  return { created: true };
}
