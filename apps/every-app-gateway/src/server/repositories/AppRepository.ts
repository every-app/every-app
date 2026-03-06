import { db } from "@/db";
import { apps, userAppAccess } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";

// Types for repository operations
type CreateApp = {
  id: string;
  organizationId: string;
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl?: string | null;
  isDefault?: boolean;
};

type UpdateApp = {
  organizationId: string;
  name?: string;
  description?: string;
  appUrl?: string;
  devUrl?: string | null;
  isDefault?: boolean;
};

/**
 * Find all apps in the catalog.
 */
async function findAll(organizationId: string) {
  return db.query.apps.findMany({
    where: eq(apps.organizationId, organizationId),
    orderBy: (apps, { asc }) => [asc(apps.name)],
  });
}

/**
 * Find all apps with access counts in a single query.
 */
async function findAllWithAccessCounts(organizationId: string) {
  const results = await db
    .select({
      id: apps.id,
      organizationId: apps.organizationId,
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
    .leftJoin(
      userAppAccess,
      and(
        eq(apps.id, userAppAccess.appId),
        eq(apps.organizationId, userAppAccess.organizationId),
      ),
    )
    .where(eq(apps.organizationId, organizationId))
    .groupBy(apps.id)
    .orderBy(apps.name);

  return results;
}

/**
 * Find an app by its primary key ID.
 */
async function findById(id: string, organizationId: string) {
  return db.query.apps.findFirst({
    where: and(eq(apps.id, id), eq(apps.organizationId, organizationId)),
  });
}

/**
 * Find an app by its appId (slug).
 */
async function findByAppId(appId: string, organizationId: string) {
  return db.query.apps.findFirst({
    where: and(eq(apps.appId, appId), eq(apps.organizationId, organizationId)),
  });
}

/**
 * Find all apps marked as default.
 */
async function findAllDefault(organizationId: string) {
  return db.query.apps.findMany({
    where: and(
      eq(apps.organizationId, organizationId),
      eq(apps.isDefault, true),
    ),
  });
}

/**
 * Create a new app in the catalog.
 */
async function create(data: CreateApp) {
  await db.insert(apps).values({
    id: data.id,
    organizationId: data.organizationId,
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
  const { organizationId, ...changes } = data;

  await db
    .update(apps)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)));
}

/**
 * Delete an app from the catalog.
 * Note: This cascades to user_app_access due to foreign key constraint.
 */
async function deleteById(id: string, organizationId: string) {
  await db
    .delete(apps)
    .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)));
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
