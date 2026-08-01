import { db } from "@/db";
import { apps, userAppAccess } from "@/db/schema";
import { and, count, eq } from "drizzle-orm";

// Types for repository operations
type CreateApp = {
  id: string;
  organizationId: string;
  appSlug: string;
  name: string;
  description: string;
  // Perimeter registry columns, written at `everyapp deploy` registration time.
  hostname: string;
  workerName: string;
  manifest: string;
  tier?: string;
  status?: string;
  isDefault?: boolean;
};

type UpdateApp = {
  organizationId: string;
  name?: string;
  description?: string;
  hostname?: string;
  workerName?: string;
  manifest?: string;
  status?: string;
  isDefault?: boolean;
};

type CreateInitialAccess = {
  id: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  grantedBy?: string | null;
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
      appId: apps.appSlug,
      name: apps.name,
      description: apps.description,
      hostname: apps.hostname,
      workerName: apps.workerName,
      tier: apps.tier,
      manifest: apps.manifest,
      status: apps.status,
      isDefault: apps.isDefault,
      createdAt: apps.createdAt,
      updatedAt: apps.updatedAt,
      accessCount: count(userAppAccess.id),
    })
    .from(apps)
    .leftJoin(
      userAppAccess,
      and(
        eq(apps.id, userAppAccess.appRowId),
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
 * Find an app by its routing slug.
 */
async function findByAppSlug(appSlug: string, organizationId: string) {
  return db.query.apps.findFirst({
    where: and(
      eq(apps.appSlug, appSlug),
      eq(apps.organizationId, organizationId),
    ),
  });
}

/**
 * Find an app by routing hostname. Hostnames are globally unique across the
 * gateway (one subdomain namespace), so this deliberately has no org filter.
 */
async function findByHostname(hostname: string) {
  return db.query.apps.findFirst({
    where: eq(apps.hostname, hostname),
  });
}

/**
 * Find an app by Cloudflare worker script name. Worker names share one
 * namespace per Cloudflare account, so this deliberately has no org filter.
 */
async function findByWorkerName(workerName: string) {
  return db.query.apps.findFirst({
    where: eq(apps.workerName, workerName),
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
 * Create a newly registered app and its initial ACL in one D1 transaction.
 */
async function createWithInitialAccess(
  data: CreateApp,
  accessRecords: CreateInitialAccess[],
) {
  const appInsert = db.insert(apps).values({
    id: data.id,
    organizationId: data.organizationId,
    appSlug: data.appSlug,
    name: data.name,
    description: data.description,
    hostname: data.hostname,
    workerName: data.workerName,
    manifest: data.manifest,
    tier: data.tier ?? "service_binding",
    status: data.status ?? "active",
    isDefault: data.isDefault ?? false,
  });
  const accessInserts = accessRecords.map((record) =>
    db
      .insert(userAppAccess)
      .values({
        id: record.id,
        organizationId: record.organizationId,
        userId: record.userId,
        appRowId: record.appRowId,
        grantedBy: record.grantedBy,
      })
      .onConflictDoNothing({
        target: [
          userAppAccess.organizationId,
          userAppAccess.userId,
          userAppAccess.appRowId,
        ],
      }),
  );

  await db.batch([appInsert, ...accessInserts]);
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
  findByAppSlug,
  findByHostname,
  findByWorkerName,
  findAllDefault,
  createWithInitialAccess,
  update,
  delete: deleteById,
} as const;
