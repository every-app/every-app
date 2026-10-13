import { db } from "@/db";
import { apps, userAccessTokens, userAppAccess } from "@/db/schema";
import { and, count, eq, isNull, ne } from "drizzle-orm";

/** Status of a deleted app's tombstone row (see {@link tombstone}). */
export const DELETED_APP_STATUS = "deleted";

const notDeleted = ne(apps.status, DELETED_APP_STATUS);

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
  /** Required: the column defaults to true, for rows older code writes. */
  legacyNames: boolean;
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
  versionId?: string;
  deployedAt?: Date;
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
    where: and(eq(apps.organizationId, organizationId), notDeleted),
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
    .where(and(eq(apps.organizationId, organizationId), notDeleted))
    .groupBy(apps.id)
    .orderBy(apps.name);

  return results;
}

/**
 * Find an app by its primary key ID.
 */
async function findById(id: string, organizationId: string) {
  return db.query.apps.findFirst({
    where: and(
      eq(apps.id, id),
      eq(apps.organizationId, organizationId),
      notDeleted,
    ),
  });
}

/**
 * Find an app by its routing slug, including a deleted app's tombstone (its
 * slug stays reserved, and a redeploy by the same org restores it).
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
 * Tombstones are included: their hostnames stay reserved.
 */
async function findByHostname(hostname: string) {
  return db.query.apps.findFirst({
    where: eq(apps.hostname, hostname),
  });
}

/**
 * Find an app by Cloudflare worker script name. Worker names share one
 * namespace per Cloudflare account, so this deliberately has no org filter.
 * Tombstones are included: their worker names stay reserved.
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
      notDeleted,
    ),
  });
}

function insertAccess(accessRecords: CreateInitialAccess[]) {
  return accessRecords.map((record) =>
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
    legacyNames: data.legacyNames,
    manifest: data.manifest,
    tier: data.tier ?? "service_binding",
    status: data.status ?? "active",
    isDefault: data.isDefault ?? false,
  });
  await db.batch([appInsert, ...insertAccess(accessRecords)]);
}

/**
 * Bring a deleted app back on redeploy by its own organization: update the
 * tombstone and give it a fresh initial ACL in one D1 transaction, as if it
 * were registered for the first time.
 */
async function restoreWithInitialAccess(
  id: string,
  data: UpdateApp,
  accessRecords: CreateInitialAccess[],
) {
  const { organizationId, ...changes } = data;
  const appUpdate = db
    .update(apps)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId)));

  await db.batch([appUpdate, ...insertAccess(accessRecords)]);
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
 * Delete an app, leaving a tombstone: the row stays with status "deleted",
 * so the perimeter stops routing it, the binding reconcile drops its service
 * binding, and its slug, hostname and worker name stay reserved to this
 * organization. (Dropping the row would let another org register the same
 * slug, and the old Worker would accept identity tokens minted for it.)
 * Everyone's access and any personal access tokens bound to it go with it.
 */
async function tombstone(id: string, organizationId: string) {
  const now = new Date();
  await db.batch([
    db
      .update(apps)
      .set({ status: DELETED_APP_STATUS, isDefault: false, updatedAt: now })
      .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId))),
    db
      .delete(userAppAccess)
      .where(
        and(
          eq(userAppAccess.appRowId, id),
          eq(userAppAccess.organizationId, organizationId),
        ),
      ),
    db
      .update(userAccessTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(userAccessTokens.appRowId, id),
          eq(userAccessTokens.organizationId, organizationId),
          isNull(userAccessTokens.revokedAt),
        ),
      ),
  ]);
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
  restoreWithInitialAccess,
  update,
  tombstone,
} as const;
