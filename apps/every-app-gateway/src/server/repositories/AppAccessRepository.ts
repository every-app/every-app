import { db } from "@/db";
import { userAppAccess, apps, users, members } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateAccess = {
  id: string;
  organizationId: string;
  userId: string;
  appId: string; // References apps.id (not apps.appId)
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
      appId: userAppAccess.appId,
      grantedAt: userAppAccess.grantedAt,
      grantedBy: userAppAccess.grantedBy,
      app: {
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
      },
    })
    .from(userAppAccess)
    .innerJoin(
      apps,
      and(
        eq(userAppAccess.appId, apps.id),
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
async function findAllByAppId(appId: string, organizationId: string) {
  return db
    .select({
      id: userAppAccess.id,
      userId: userAppAccess.userId,
      appId: userAppAccess.appId,
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
        eq(userAppAccess.appId, appId),
        eq(userAppAccess.organizationId, organizationId),
      ),
    );
}

/**
 * Check if a user has access to a specific app.
 */
async function findByUserAndApp(
  userId: string,
  appId: string,
  organizationId: string,
) {
  return db.query.userAppAccess.findFirst({
    where: and(
      eq(userAppAccess.userId, userId),
      eq(userAppAccess.appId, appId),
      eq(userAppAccess.organizationId, organizationId),
    ),
  });
}

/**
 * Check if a user has access to an app by app slug (appId field in apps table).
 */
async function findByUserAndAppSlug(
  userId: string,
  appSlug: string,
  organizationId: string,
): Promise<{
  access: typeof userAppAccess.$inferSelect;
  app: typeof apps.$inferSelect;
} | null> {
  const result = await db
    .select({
      access: userAppAccess,
      app: apps,
    })
    .from(userAppAccess)
    .innerJoin(apps, eq(userAppAccess.appId, apps.id))
    .where(
      and(
        eq(userAppAccess.userId, userId),
        eq(apps.appId, appSlug),
        eq(userAppAccess.organizationId, organizationId),
        eq(apps.organizationId, organizationId),
      ),
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Grant access to an app for a user.
 */
async function create(data: CreateAccess) {
  await db.insert(userAppAccess).values({
    id: data.id,
    organizationId: data.organizationId,
    userId: data.userId,
    appId: data.appId,
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
    appId: string;
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
        appId: record.appId,
        grantedBy: record.grantedBy,
      })
      .onConflictDoNothing({
        target: [
          userAppAccess.organizationId,
          userAppAccess.userId,
          userAppAccess.appId,
        ],
      }),
  );

  const [first, ...rest] = insertStatements;
  await db.batch([first, ...rest]);
}

/**
 * Revoke access from a user for an app.
 */
async function deleteByUserAndApp(
  userId: string,
  appId: string,
  organizationId: string,
) {
  await db
    .delete(userAppAccess)
    .where(
      and(
        eq(userAppAccess.userId, userId),
        eq(userAppAccess.appId, appId),
        eq(userAppAccess.organizationId, organizationId),
      ),
    );
}

/**
 * Revoke access from multiple users for an app.
 */
async function deleteByAppAndUsers(
  appId: string,
  userIds: string[],
  organizationId: string,
) {
  if (userIds.length === 0) return;

  await db
    .delete(userAppAccess)
    .where(
      and(
        eq(userAppAccess.appId, appId),
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
  findAllByAppId,
  findByUserAndApp,
  findByUserAndAppSlug,
  create,
  createMany,
  deleteByUserAndApp,
  deleteByAppAndUsers,
  deleteByOrganizationAndUser,
} as const;
