import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { AppRepository } from "../repositories/AppRepository";
import { UserRepository } from "../repositories/UserRepository";

/**
 * Get all apps a user has access to.
 */
async function getAppsForUser(userId: string) {
  const accessRecords = await AppAccessRepository.findAllByUserId(userId);
  return {
    apps: accessRecords.map((record) => ({
      ...record.app,
      grantedAt: record.grantedAt,
    })),
  };
}

/**
 * Get all users with access to an app.
 */
async function getUsersForApp(appId: string) {
  const accessRecords = await AppAccessRepository.findAllByAppId(appId);
  return {
    users: accessRecords.map((record) => ({
      ...record.user,
      grantedAt: record.grantedAt,
      grantedBy: record.grantedBy,
    })),
  };
}

/**
 * Get access state for all users for a specific app.
 * Returns all users with a flag indicating if they have access.
 */
async function getAccessStateForApp(appId: string) {
  const [allUsers, accessRecords] = await Promise.all([
    UserRepository.findAllForList(),
    AppAccessRepository.findAllByAppId(appId),
  ]);

  const accessUserIds = new Set(accessRecords.map((r) => r.userId));

  return {
    users: allUsers.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      hasAccess: accessUserIds.has(user.id),
    })),
  };
}

/**
 * Check if a user has access to an app.
 */
async function hasAccess(userId: string, appId: string) {
  const access = await AppAccessRepository.findByUserAndApp(userId, appId);
  return access !== null && access !== undefined;
}

/**
 * Grant access to an app for a user.
 */
async function grantAccess(userId: string, appId: string, grantedBy?: string) {
  // Check if already has access
  const existing = await AppAccessRepository.findByUserAndApp(userId, appId);
  if (existing) {
    return; // Already has access, nothing to do
  }

  await AppAccessRepository.create({
    id: crypto.randomUUID(),
    userId,
    appId,
    grantedBy,
  });
}

/**
 * Revoke access from a user for an app.
 */
async function revokeAccess(userId: string, appId: string) {
  await AppAccessRepository.deleteByUserAndApp(userId, appId);
}

/**
 * Update access for multiple users for an app.
 * Takes the full list of user IDs who should have access.
 * Prevents owners from revoking their own access.
 */
async function updateAccessForApp(
  appId: string,
  userIdsWithAccess: string[],
  grantedBy?: string,
) {
  // Get current access state
  const currentAccess = await AppAccessRepository.findAllByAppId(appId);
  const currentUserIds = new Set(currentAccess.map((r) => r.userId));
  const newUserIds = new Set(userIdsWithAccess);

  // Find users to grant (in new list but not in current)
  const toGrant = userIdsWithAccess.filter((id) => !currentUserIds.has(id));

  // Find users to revoke (in current but not in new list)
  // Prevent owners from revoking their own access
  const toRevoke = [...currentUserIds].filter(
    (id) => !newUserIds.has(id) && id !== grantedBy,
  );

  // Grant access to new users
  if (toGrant.length > 0) {
    const accessRecords = toGrant.map((userId) => ({
      id: crypto.randomUUID(),
      userId,
      appId,
      grantedBy,
    }));
    await AppAccessRepository.createMany(accessRecords);
  }

  // Revoke access from removed users
  if (toRevoke.length > 0) {
    await AppAccessRepository.deleteByAppAndUsers(appId, toRevoke);
  }

  return {
    granted: toGrant.length,
    revoked: toRevoke.length,
  };
}

/**
 * Grant default apps to a new user.
 * Called when a user completes signup.
 */
async function grantDefaultAppsToUser(userId: string) {
  const defaultApps = await AppRepository.findAllDefault();

  if (defaultApps.length === 0) {
    return;
  }

  const accessRecords = defaultApps.map((app) => ({
    id: crypto.randomUUID(),
    userId,
    appId: app.id,
    grantedBy: null, // System-granted
  }));

  await AppAccessRepository.createMany(accessRecords);
}

export const AppAccessService = {
  getAppsForUser,
  getUsersForApp,
  getAccessStateForApp,
  hasAccess,
  grantAccess,
  revokeAccess,
  updateAccessForApp,
  grantDefaultAppsToUser,
} as const;
