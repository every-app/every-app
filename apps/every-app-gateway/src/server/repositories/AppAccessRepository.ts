import { db } from "@/db";
import { userAppAccess, apps, users, members } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateAccess = {
  id: string;
  organizationId: string;
  userId: string;
  appRowId: string;
  grantedBy?: string | null;
};

/**
 * Find all app access records for a user, including app details.
 */
async function findAllByUserId(userId: string, organizationId: string) {
  return db
    .select({
      id: userAppAccess.id,
      userId: userAppAccess.userId,
      appRowId: userAppAccess.appRowId,
      grantedAt: userAppAccess.grantedAt,
      grantedBy: userAppAccess.grantedBy,
      app: {
        id: apps.id,
        organizationId: apps.organizationId,
        appId: apps.appSlug,
        name: apps.name,
        description: apps.description,
        hostname: apps.hostname,
        status: apps.status,
        isDefault: apps.isDefault,
        createdAt: apps.createdAt,
        updatedAt: apps.updatedAt,
      },
    })
    .from(userAppAccess)
    .innerJoin(
      apps,
      and(
        eq(userAppAccess.appRowId, apps.id),
        eq(userAppAccess.organizationId, apps.organizationId),
      ),
    )
    .where(
      and(
        eq(userAppAccess.userId, userId),
        eq(userAppAccess.organizationId, organizationId),
      ),
    );
}

/**
 * Find all users with access to a specific app.
 */
async function findAllByAppRowId(appRowId: string, organizationId: string) {
  return db
    .select({
      id: userAppAccess.id,
      userId: userAppAccess.userId,
      appRowId: userAppAccess.appRowId,
      grantedAt: userAppAccess.grantedAt,
      grantedBy: userAppAccess.grantedBy,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        role: members.role,
        status: users.status,
      },
    })
    .from(userAppAccess)
    .innerJoin(users, eq(userAppAccess.userId, users.id))
    .innerJoin(
      members,
      and(
        eq(members.userId, users.id),
        eq(members.organizationId, userAppAccess.organizationId),
      ),
    )
    .where(
      and(
        eq(userAppAccess.appRowId, appRowId),
        eq(userAppAccess.organizationId, organizationId),
      ),
    );
}

/**
 * Check if a user has access to an app by its routing slug.
 */
async function hasAccessByUserAndAppSlug(
  userId: string,
  appSlug: string,
  organizationId: string,
): Promise<boolean> {
  const result = await db
    .select({ id: userAppAccess.id })
    .from(userAppAccess)
    .innerJoin(apps, eq(userAppAccess.appRowId, apps.id))
    .where(
      and(
        eq(userAppAccess.userId, userId),
        eq(apps.appSlug, appSlug),
        eq(userAppAccess.organizationId, organizationId),
        eq(apps.organizationId, organizationId),
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
