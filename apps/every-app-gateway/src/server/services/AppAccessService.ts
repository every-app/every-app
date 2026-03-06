import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { AppRepository } from "../repositories/AppRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";

/**
 * Get all apps a user has access to.
 */
async function getAppsForUser(userId: string, organizationId: string) {
  const accessRecords = await AppAccessRepository.findAllByUserId(
    userId,
    organizationId,
  );
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
async function getUsersForApp(appId: string, organizationId: string) {
  const accessRecords = await AppAccessRepository.findAllByAppId(
    appId,
    organizationId,
  );
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
async function getAccessStateForApp(
  appId: string,
  organizationId: string,
) {
  const [allUsers, accessRecords] = await Promise.all([
    OrganizationMembersRepository.listMembersForOrganization(organizationId),
    AppAccessRepository.findAllByAppId(appId, organizationId),
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
async function hasAccess(
  userId: string,
  appId: string,
  organizationId: string,
) {
  const access = await AppAccessRepository.findByUserAndApp(
    userId,
    appId,
    organizationId,
  );
  return access !== null && access !== undefined;
}

/**
 * Grant access to an app for a user.
 */
async function grantAccess(
  userId: string,
  appId: string,
  organizationId: string,
  grantedBy?: string,
) {
  // Check if already has access
  const existing = await AppAccessRepository.findByUserAndApp(
    userId,
    appId,
    organizationId,
  );
  if (existing) {
    return; // Already has access, nothing to do
  }

  await AppAccessRepository.create({
    id: crypto.randomUUID(),
    organizationId,
    userId,
    appId,
    grantedBy,
  });
}

/**
 * Grant access to an app for multiple users (additive-only).
 *
 * This never revokes existing access. Existing records are ignored.
 * Use updateAccessForApp when the caller needs full replacement semantics.
 */
async function grantAccessBatchAdditive(
  userIds: string[],
  appId: string,
  organizationId: string,
  grantedBy?: string,
) {
  if (userIds.length === 0) {
    return;
  }

  await AppAccessRepository.createMany(
    userIds.map((userId) => ({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      appId,
      grantedBy,
    })),
  );
}

/**
 * Revoke access from a user for an app.
 */
async function revokeAccess(
  userId: string,
  appId: string,
  organizationId: string,
) {
  await AppAccessRepository.deleteByUserAndApp(userId, appId, organizationId);
}

/**
 * Update access for multiple users for an app.
 * Takes the full list of user IDs who should have access.
 * Prevents owners from revoking their own access.
 */
async function updateAccessForApp(
  appId: string,
  organizationId: string,
  userIdsWithAccess: string[],
  grantedBy: string | null,
) {
  const app = await AppRepository.findById(appId, organizationId);
  if (!app) {
    throw new Error("App not found");
  }

  const organizationUsers =
    await OrganizationMembersRepository.listMembersForOrganization(
      organizationId,
    );
  const allowedUserIds = new Set(organizationUsers.map((user) => user.id));
  const validUserIdsWithAccess = userIdsWithAccess.filter((userId) =>
    allowedUserIds.has(userId),
  );

  // Get current access state
  const currentAccess = await AppAccessRepository.findAllByAppId(
    appId,
    organizationId,
  );
  const currentUserIds = new Set(currentAccess.map((r) => r.userId));
  const newUserIds = new Set(validUserIdsWithAccess);

  // Find users to grant (in new list but not in current)
  const toGrant = validUserIdsWithAccess.filter(
    (id) => !currentUserIds.has(id),
  );

  // Find users to revoke (in current but not in new list).
  // For dashboard-driven changes, preserve the acting user's access so they
  // cannot lock themselves out mid-session.
  const toRevoke = [...currentUserIds].filter((id) => {
    if (newUserIds.has(id)) {
      return false;
    }

    if (grantedBy && id === grantedBy) {
      return false;
    }

    return true;
  });

  // Grant access to new users
  if (toGrant.length > 0) {
    const accessRecords = toGrant.map((userId) => ({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      appId,
      grantedBy,
    }));
    await AppAccessRepository.createMany(accessRecords);
  }

  // Revoke access from removed users
  if (toRevoke.length > 0) {
    await AppAccessRepository.deleteByAppAndUsers(
      appId,
      toRevoke,
      organizationId,
    );
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
async function grantDefaultAppsToUser(userId: string, organizationId?: string) {
  if (!organizationId) {
    return;
  }

  const defaultApps = await AppRepository.findAllDefault(organizationId);

  if (defaultApps.length === 0) {
    return;
  }

  const accessRecords = defaultApps.map((app) => ({
    id: crypto.randomUUID(),
    organizationId,
    userId,
    appId: app.id,
    grantedBy: null,
  }));

  await AppAccessRepository.createMany(accessRecords);
}

export const AppAccessService = {
  getAppsForUser,
  getUsersForApp,
  getAccessStateForApp,
  hasAccess,
  grantAccess,
  grantAccessBatchAdditive,
  revokeAccess,
  updateAccessForApp,
  grantDefaultAppsToUser,
} as const;
