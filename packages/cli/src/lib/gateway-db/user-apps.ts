import { randomUUID } from "node:crypto";
import { queryD1Database } from "@/lib/cloudflare-d1-queries";
import type { GatewayDbConnection } from "./connection";
import type { User } from "./users";

/**
 * Options for upserting a user app record
 */
interface UpsertUserAppOptions {
  appId: string;
  appUrl: string;
  name: string;
  description: string;
  devUrl?: string;
}

/**
 * Result of an upsert operation
 */
interface UpsertResult {
  created: boolean;
}

/**
 * Check if a UserApp record exists for a user and app
 */
async function userAppExists(
  db: GatewayDbConnection,
  userId: string,
  appId: string,
): Promise<boolean> {
  const existingRecords = await queryD1Database<{ id: string }>(
    db.accountId,
    db.databaseId,
    "SELECT id FROM user_apps WHERE user_id = ? AND app_id = ?",
    [userId, appId],
  );

  return existingRecords.length > 0;
}

/**
 * Insert a UserApp record if it doesn't already exist
 * @returns Whether a new record was created
 */
export async function upsertUserApp(
  db: GatewayDbConnection,
  user: User,
  options: UpsertUserAppOptions,
): Promise<UpsertResult> {
  const exists = await userAppExists(db, user.id, options.appId);

  if (exists) {
    return { created: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const recordId = randomUUID();

  const insertSql = `
    INSERT INTO user_apps (id, user_id, app_id, name, description, app_url, dev_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await queryD1Database(db.accountId, db.databaseId, insertSql, [
    recordId,
    user.id,
    options.appId,
    options.name,
    options.description,
    options.appUrl,
    options.devUrl ?? null,
    now,
    now,
  ]);

  return { created: true };
}
