import { db } from "@/db";
import { userAppAccess, apps, users } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";

// Types for repository operations
type CreateAccess = {
  id: string;
  userId: string;
  appId: string; // References apps.id (not apps.appId)
  grantedBy?: string | null;
};

/**
 * Find all app access records for a user, including app details.
 */
async function findAllByUserId(userId: string) {
  return db
    .select({
      id: userAppAccess.id,
      userId: userAppAccess.userId,
      appId: userAppAccess.appId,
      grantedAt: userAppAccess.grantedAt,
      grantedBy: userAppAccess.grantedBy,
      app: {
        id: apps.id,
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
    .innerJoin(apps, eq(userAppAccess.appId, apps.id))
    .where(eq(userAppAccess.userId, userId));
}

/**
 * Find all users with access to a specific app.
 */
async function findAllByAppId(appId: string) {
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
        role: users.role,
        status: users.status,
      },
    })
    .from(userAppAccess)
    .innerJoin(users, eq(userAppAccess.userId, users.id))
    .where(eq(userAppAccess.appId, appId));
}

/**
 * Check if a user has access to a specific app.
 */
async function findByUserAndApp(userId: string, appId: string) {
  return db.query.userAppAccess.findFirst({
    where: and(
      eq(userAppAccess.userId, userId),
      eq(userAppAccess.appId, appId),
    ),
  });
}

/**
 * Check if a user has access to an app by app slug (appId field in apps table).
 */
async function findByUserAndAppSlug(
  userId: string,
  appSlug: string,
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
    .where(and(eq(userAppAccess.userId, userId), eq(apps.appId, appSlug)))
    .limit(1);

  return result[0] ?? null;
}

/**
 * Grant access to an app for a user.
 */
async function create(data: CreateAccess) {
  await db.insert(userAppAccess).values({
    id: data.id,
    userId: data.userId,
    appId: data.appId,
    grantedBy: data.grantedBy,
  });
}

/**
 * Grant access to multiple users for an app.
 */
async function createMany(
  records: Array<{
    id: string;
    userId: string;
    appId: string;
    grantedBy?: string | null;
  }>,
) {
  if (records.length === 0) return;

  await db
    .insert(userAppAccess)
    .values(
      records.map((r) => ({
        id: r.id,
        userId: r.userId,
        appId: r.appId,
        grantedBy: r.grantedBy,
      })),
    )
    .onConflictDoNothing({
      target: [userAppAccess.userId, userAppAccess.appId],
    });
}

/**
 * Revoke access from a user for an app.
 */
async function deleteByUserAndApp(userId: string, appId: string) {
  await db
    .delete(userAppAccess)
    .where(
      and(eq(userAppAccess.userId, userId), eq(userAppAccess.appId, appId)),
    );
}

/**
 * Revoke access from multiple users for an app.
 */
async function deleteByAppAndUsers(appId: string, userIds: string[]) {
  if (userIds.length === 0) return;

  await db
    .delete(userAppAccess)
    .where(
      and(
        eq(userAppAccess.appId, appId),
        inArray(userAppAccess.userId, userIds),
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
} as const;
