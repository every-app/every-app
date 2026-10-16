import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  appTools,
  mcpConnectionApps,
  userAccessTokens,
  userAppAccess,
} from "@/db/schema";
import {
  DELETED_APP_STATUS,
  deleteUpdate,
  type AppRow,
} from "@every-app/perimeter/registry";
import { and, count, eq, inArray, isNull, ne, notExists } from "drizzle-orm";

const notDeleted = ne(apps.status, DELETED_APP_STATUS);

// Apps are registered, deployed and deleted by the CLI writing D1 itself
// (ADR-0003). The gateway edits catalog metadata, activates apps and
// deletes them from the admin UI.
type UpdateApp = {
  organizationId: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
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
      scope: apps.scope,
      manifest: apps.manifest,
      status: apps.status,
      deployedByActor: apps.deployedByActor,
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
 * The shared apps (first-party, on the hosted gateway), deleted ones aside:
 * every organization's members may open them. With
 * `exceptOrganizationId`, those another organization owns (the platform
 * organization's own are among its apps already).
 */
async function findAllShared(exceptOrganizationId?: string) {
  return db.query.apps.findMany({
    where: and(
      eq(apps.scope, "shared"),
      notDeleted,
      ...(exceptOrganizationId
        ? [ne(apps.organizationId, exceptOrganizationId)]
        : []),
    ),
    orderBy: (apps, { asc }) => [asc(apps.name)],
  });
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

/**
 * The organization's apps nobody has access to: registered while it had no
 * members, before the gateway had an owner. Shared apps are nobody's to
 * grant.
 */
async function findAllWithoutAccess(organizationId: string) {
  return db
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        eq(apps.organizationId, organizationId),
        notDeleted,
        ne(apps.scope, "shared"),
        notExists(
          db
            .select({ id: userAppAccess.id })
            .from(userAppAccess)
            .where(
              and(
                eq(userAppAccess.appRowId, apps.id),
                eq(userAppAccess.organizationId, apps.organizationId),
              ),
            ),
        ),
      ),
    );
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
 * Make a `binding` app `active` (its Worker answered over this gateway's
 * service binding). True when the app is active now; false when it was
 * deleted, disabled or never uploaded in the meantime. Concurrent requests
 * may all activate it: an app already active answers true again.
 */
async function activate(id: string, organizationId: string) {
  const rows = await db
    .update(apps)
    .set({ status: "active", updatedAt: new Date() })
    .where(
      and(
        eq(apps.id, id),
        eq(apps.organizationId, organizationId),
        inArray(apps.status, ["binding", "active"]),
      ),
    )
    .returning({ id: apps.id });
  return rows.length === 1;
}

/**
 * Delete an app, leaving a tombstone: the row stays with status "deleted",
 * so the perimeter stops routing it, the binding reconcile drops its service
 * binding, and its slug, hostname and worker name stay reserved to this
 * organization. (Dropping the row would let another org register the same
 * slug, and the old Worker would accept identity tokens minted for it.)
 * Everyone's access, any personal access tokens bound to it, its agent
 * tools snapshot and its place in AI connections go with it: the same
 * writes the CLI's `delete` makes (`deleteUpdate` in the perimeter).
 */
async function tombstone(
  app: Pick<AppRow, "id" | "organizationId" | "status">,
) {
  const update = deleteUpdate(app);
  if (!update) return;
  const { id, organizationId } = app;
  const now = new Date();
  await db.batch([
    db
      .update(apps)
      .set({ ...update, updatedAt: now })
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
    db
      .delete(appTools)
      .where(
        and(
          eq(appTools.appRowId, id),
          eq(appTools.organizationId, organizationId),
        ),
      ),
    db
      .delete(appToolCatalogs)
      .where(
        and(
          eq(appToolCatalogs.appRowId, id),
          eq(appToolCatalogs.organizationId, organizationId),
        ),
      ),
    // Out of every AI connection that chose it: a later deploy brings the
    // same row back, and must not bring it back into those connections.
    db.delete(mcpConnectionApps).where(
      inArray(
        mcpConnectionApps.appRowId,
        db
          .select({ id: apps.id })
          .from(apps)
          .where(and(eq(apps.id, id), eq(apps.organizationId, organizationId))),
      ),
    ),
  ]);
}

export const AppRepository = {
  findAll,
  findAllWithAccessCounts,
  findAllShared,
  findById,
  findByAppSlug,
  findAllDefault,
  findAllWithoutAccess,
  update,
  activate,
  tombstone,
} as const;
