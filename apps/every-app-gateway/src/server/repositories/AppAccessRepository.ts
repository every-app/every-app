import { db } from "@/db";
import { userAppAccess, apps, users, members, groups } from "@/db/schema";
import { eq, and, asc, inArray, ne, sql } from "drizzle-orm";
import { DELETED_APP_STATUS } from "@every-app/perimeter/registry";
import { manifestIcon } from "./AppRepository";
import { accessToApp, effectiveAccess } from "./effective-access";

// Types for repository operations
type CreateAccess = {
  id: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  grantedBy?: string | null;
};

/**
 * The apps a user opens in an organization (the launcher), with how:
 * `via` names the group for a grant that comes through one, null for a
 * direct grant. A user granted an app both ways gets it once, as direct.
 * The registry columns the settings model reads (tier, manifest, recorded
 * secret names, version) come along for the service to evaluate the
 * app's setup; it keeps them server-side.
 */
async function findAllByUserId(userId: string, organizationId: string) {
  const access = effectiveAccess(organizationId);
  const rows = await db
    .select({
      appRowId: access.appRowId,
      grantedAt: access.grantedAt,
      groupId: access.groupId,
      groupName: groups.name,
      app: {
        id: apps.id,
        organizationId: apps.organizationId,
        appId: apps.appSlug,
        name: apps.name,
        description: apps.description,
        hostname: apps.hostname,
        tier: apps.tier,
        scope: apps.scope,
        status: apps.status,
        icon: manifestIcon,
        isDefault: apps.isDefault,
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
        manifest: apps.manifest,
        secretNames: apps.secretNames,
        versionId: apps.versionId,
      },
    })
    .from(access)
    .innerJoin(
      apps,
      and(
        eq(access.appRowId, apps.id),
        eq(apps.organizationId, organizationId),
      ),
    )
    .leftJoin(groups, eq(groups.id, access.groupId))
    .where(and(eq(access.userId, userId), ne(apps.status, DELETED_APP_STATUS)))
    // Direct grants first, then the oldest group grant.
    .orderBy(
      asc(apps.name),
      sql`${access.groupId} IS NOT NULL`,
      asc(access.grantedAt),
    );

  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (seen.has(row.appRowId)) return [];
    seen.add(row.appRowId);
    return [
      {
        appRowId: row.appRowId,
        grantedAt: row.grantedAt,
        via:
          row.groupId && row.groupName
            ? { groupId: row.groupId, name: row.groupName }
            : null,
        app: row.app,
      },
    ];
  });
}

/**
 * Everyone who opens an app (the admin modal): one row per member with
 * any grant, saying whether they hold a direct one (`direct`, what the
 * modal's checkbox edits) and the names of the groups that grant it
 * (`viaGroups`).
 */
async function findAllByAppRowId(appRowId: string, organizationId: string) {
  const access = effectiveAccess(organizationId);
  const rows = await db
    .select({
      userId: access.userId,
      grantedAt: access.grantedAt,
      groupId: access.groupId,
      groupName: groups.name,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        role: members.role,
        status: users.status,
      },
    })
    .from(access)
    .innerJoin(users, eq(access.userId, users.id))
    .innerJoin(
      members,
      and(
        eq(members.userId, users.id),
        eq(members.organizationId, organizationId),
      ),
    )
    .leftJoin(groups, eq(groups.id, access.groupId))
    .where(eq(access.appRowId, appRowId))
    .orderBy(asc(access.userId), asc(groups.name));

  const byUser = new Map<
    string,
    {
      userId: string;
      appRowId: string;
      grantedAt: Date;
      direct: boolean;
      viaGroups: string[];
      user: (typeof rows)[number]["user"];
    }
  >();
  for (const row of rows) {
    const entry = byUser.get(row.userId) ?? {
      userId: row.userId,
      appRowId,
      grantedAt: row.grantedAt,
      direct: false,
      viaGroups: [],
      user: row.user,
    };
    if (row.groupId) {
      if (row.groupName) entry.viaGroups.push(row.groupName);
    } else {
      entry.direct = true;
      entry.grantedAt = row.grantedAt;
    }
    byUser.set(row.userId, entry);
  }
  return [...byUser.values()];
}

/**
 * Whether a user opens an app of the organization, by its routing slug:
 * the perimeter's check. Never a deleted app's tombstone, whatever grants
 * are left on it.
 */
async function hasAccessByUserAndAppSlug(
  userId: string,
  appSlug: string,
  organizationId: string,
): Promise<boolean> {
  const result = await db
    .select({ id: apps.id })
    .from(apps)
    .where(
      and(
        eq(apps.appSlug, appSlug),
        eq(apps.organizationId, organizationId),
        ne(apps.status, DELETED_APP_STATUS),
        accessToApp(userId, organizationId),
      ),
    )
    .limit(1);

  return result.length > 0;
}

/**
 * Grant access to an app for a user.
 */
async function create(data: CreateAccess) {
  await db.insert(userAppAccess).values({
    id: data.id,
    organizationId: data.organizationId,
    userId: data.userId,
    appRowId: data.appRowId,
    grantedBy: data.grantedBy,
  });
}

/**
 * Grant access to multiple users for an app.
 * Uses onConflictDoNothing so re-granting existing access is a no-op.
 */
async function createMany(
  records: Array<{
    id: string;
    organizationId: string;
    userId: string;
    appRowId: string;
    grantedBy?: string | null;
  }>,
) {
  if (records.length === 0) return;

  const insertStatements = records.map((record) =>
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

  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);
}

/**
 * Revoke access from multiple users for an app.
 */
async function deleteByAppRowAndUsers(
  appRowId: string,
  userIds: string[],
  organizationId: string,
) {
  if (userIds.length === 0) return;

  await db
    .delete(userAppAccess)
    .where(
      and(
        eq(userAppAccess.appRowId, appRowId),
        eq(userAppAccess.organizationId, organizationId),
        inArray(userAppAccess.userId, userIds),
      ),
    );
}

async function deleteByOrganizationAndUser(
  organizationId: string,
  userId: string,
) {
  await db
    .delete(userAppAccess)
    .where(
      and(
        eq(userAppAccess.organizationId, organizationId),
        eq(userAppAccess.userId, userId),
      ),
    );
}

export const AppAccessRepository = {
  findAllByUserId,
  findAllByAppRowId,
  hasAccessByUserAndAppSlug,
  create,
  createMany,
  deleteByAppRowAndUsers,
  deleteByOrganizationAndUser,
} as const;
