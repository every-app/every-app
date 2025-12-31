import { db } from "@/db";
import { userApps } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// Types for repository operations
type CreateUserApp = {
  id: string;
  userId: string;
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl?: string | null;
};

type UpdateUserApp = {
  name?: string;
  description?: string;
  appUrl?: string;
  devUrl?: string | null;
};

/**
 * Find all user apps for a user.
 */
async function findAllByUserId(userId: string) {
  return db.query.userApps.findMany({
    where: eq(userApps.userId, userId),
  });
}

/**
 * Find a user app by ID and verify ownership.
 */
async function findByIdAndUserId(id: string, userId: string) {
  return db.query.userApps.findFirst({
    where: and(eq(userApps.id, id), eq(userApps.userId, userId)),
  });
}

/**
 * Find a user app by appId and verify ownership.
 */
async function findByAppIdAndUserId(appId: string, userId: string) {
  return db.query.userApps.findFirst({
    where: and(eq(userApps.appId, appId), eq(userApps.userId, userId)),
  });
}

/**
 * Create a new user app.
 */
async function create(data: CreateUserApp) {
  const now = new Date();

  await db.insert(userApps).values({
    id: data.id,
    userId: data.userId,
    appId: data.appId,
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
    devUrl: data.devUrl,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Update a user app.
 */
async function update(id: string, userId: string, data: UpdateUserApp) {
  await db
    .update(userApps)
    .set({ ...data, updatedAt: new Date() })
    .where(and(eq(userApps.id, id), eq(userApps.userId, userId)));
}

/**
 * Delete a user app.
 */
async function deleteById(id: string, userId: string) {
  await db
    .delete(userApps)
    .where(and(eq(userApps.id, id), eq(userApps.userId, userId)));
}

export const UserAppRepository = {
  findAllByUserId,
  findByIdAndUserId,
  findByAppIdAndUserId,
  create,
  update,
  delete: deleteById,
} as const;
