import { db } from "@/db";
import {
  apps,
  appToolCatalogs,
  appTools,
  groupAppAccess,
  mcpConnectionApps,
  orgAppSettings,
  remoteMcpTools,
  userAccessTokens,
  userAppAccess,
} from "@/db/schema";
import {
  DELETED_APP_STATUS,
  deleteUpdate,
  type AppRow,
} from "@every-app/perimeter/registry";
import {
  and,
  countDistinct,
  eq,
  inArray,
  isNull,
  ne,
  not,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { anyAccessToApp, effectiveAccess } from "./effective-access";

const notDeleted = ne(apps.status, DELETED_APP_STATUS);

/** The launcher icon's path the app's manifest names (`icon`), or null. */
export const manifestIcon = sql<
  string | null
>`json_extract(${apps.manifest}, '$.icon')`;

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
 * Find all apps with access counts in a single query: how many distinct
 * members open each, directly or through a group. The version comes
 * along for the setup evaluation's cache key; the service keeps it
 * server-side.
 */
async function findAllWithAccessCounts(organizationId: string) {
  const access = effectiveAccess(organizationId);
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
      emailSenders: apps.emailSenders,
      emailInbound: apps.emailInbound,
      secretNames: apps.secretNames,
      versionId: apps.versionId,
      status: apps.status,
      deployedByActor: apps.deployedByActor,
      isDefault: apps.isDefault,
      createdAt: apps.createdAt,
      updatedAt: apps.updatedAt,
      accessCount: countDistinct(access.userId),
    })
    .from(apps)
    .leftJoin(access, eq(apps.id, access.appRowId))
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
    extras: { icon: manifestIcon.as("icon") },
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
 * Find an app the organization's members can call, by its primary key: the
 * organization's own, or a shared app another organization (the platform's)
 * owns. What a per-organization setting on the app (a monthly cap) may name.
 */
async function findCallableById(id: string, organizationId: string) {
  return db.query.apps.findFirst({
    where: and(
      eq(apps.id, id),
      or(eq(apps.organizationId, organizationId), eq(apps.scope, "shared")),
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
 * The organization's apps nobody has access to, directly or through a
 * group: registered while it had no members, before the gateway had an
 * owner. Shared apps are nobody's to grant.
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
        not(anyAccessToApp(organizationId)),
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
 * Everyone's access (direct and through groups), any personal access
 * tokens bound to it, its agent tools snapshot (for a remote MCP app,
 * what its server listed too), its place in AI connections and every
 * organization's settings on it (a monthly cap) go with it: the writes the CLI's `delete` makes (`deleteUpdate` in
 * the perimeter), plus the group grants and the cap.
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
      .delete(groupAppAccess)
      .where(
        and(
          eq(groupAppAccess.appRowId, id),
          eq(groupAppAccess.organizationId, organizationId),
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
    db
      .delete(remoteMcpTools)
      .where(
        and(
          eq(remoteMcpTools.appRowId, id),
          eq(remoteMcpTools.organizationId, organizationId),
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
    // And every organization's settings on it (a shared app is capped per
    // organization): a cap on an app nobody can call could not be cleared,
    // and must not bind a later deploy under the same slug.
    db.delete(orgAppSettings).where(
      inArray(
        orgAppSettings.appRowId,
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
  findCallableById,
  findByAppSlug,
  findAllDefault,
  findAllWithoutAccess,
  update,
  activate,
  tombstone,
} as const;
