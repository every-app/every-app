import { db } from "@/db";
import { apps, userAppAccess } from "@/db/schema";
import { eq, sql, count } from "drizzle-orm";

// Types for repository operations
type CreateApp = {
  id: string;
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl?: string | null;
  isDefault?: boolean;
};

type UpdateApp = {
  name?: string;
  description?: string;
  appUrl?: string;
  devUrl?: string | null;
  isDefault?: boolean;
};

/**
 * Find all apps in the catalog.
 */
async function findAll() {
  return db.query.apps.findMany({
    orderBy: (apps, { asc }) => [asc(apps.name)],
  });
}

/**
 * Find all apps with access counts in a single query.
 */
async function findAllWithAccessCounts() {
  const results = await db
    .select({
      id: apps.id,
      appId: apps.appId,
      name: apps.name,
      description: apps.description,
      appUrl: apps.appUrl,
      devUrl: apps.devUrl,
      isDefault: apps.isDefault,
      createdAt: apps.createdAt,
      updatedAt: apps.updatedAt,
      accessCount: count(userAppAccess.id),
    })
    .from(apps)
    .leftJoin(userAppAccess, eq(apps.id, userAppAccess.appId))
    .groupBy(apps.id)
    .orderBy(apps.name);

  return results;
}

/**
 * Find an app by its primary key ID.
 */
async function findById(id: string) {
  return db.query.apps.findFirst({
    where: eq(apps.id, id),
  });
}

/**
 * Find an app by its appId (slug).
 */
async function findByAppId(appId: string) {
  return db.query.apps.findFirst({
    where: eq(apps.appId, appId),
  });
}

/**
 * Find all apps marked as default.
 */
async function findAllDefault() {
  return db.query.apps.findMany({
    where: eq(apps.isDefault, true),
  });
}

/**
 * Create a new app in the catalog.
 */
async function create(data: CreateApp) {
  await db.insert(apps).values({
    id: data.id,
    appId: data.appId,
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
    devUrl: data.devUrl,
    isDefault: data.isDefault ?? false,
  });
}

/**
 * Update an app in the catalog.
 */
async function update(id: string, data: UpdateApp) {
  await db
    .update(apps)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(apps.id, id));
}

/**
 * Delete an app from the catalog.
 * Note: This cascades to user_app_access due to foreign key constraint.
 */
async function deleteById(id: string) {
  await db.delete(apps).where(eq(apps.id, id));
}

export const AppRepository = {
  findAll,
  findAllWithAccessCounts,
  findById,
  findByAppId,
  findAllDefault,
  create,
  update,
  delete: deleteById,
} as const;
