import { env } from "cloudflare:workers";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { AppRepository } from "../repositories/AppRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";

/**
 * Get all apps a user has access to: the organization's own they have
 * installed, and on the hosted gateway the shared apps, which every
 * member of every organization may open.
 */
async function getAppsForUser(ctx: OrgContext) {
  const [accessRecords, shared] = await Promise.all([
    AppAccessRepository.findAllByUserId(ctx.userId, ctx.orgId),
    platformPolicy(env).sharedApps ? AppRepository.findAllShared() : [],
  ]);
  const own = accessRecords.map((record) => ({
    ...record.app,
    grantedAt: record.grantedAt,
  }));
  const ownIds = new Set(own.map((app) => app.id));
  return {
    apps: [
      ...own,
      ...shared
        .filter((app) => !ownIds.has(app.id))
        .map((app) => ({
          id: app.id,
          organizationId: app.organizationId,
          appId: app.appSlug,
          name: app.name,
          description: app.description,
          hostname: app.hostname,
          scope: app.scope,
          status: app.status,
          isDefault: app.isDefault,
          createdAt: app.createdAt,
          updatedAt: app.updatedAt,
          // Nobody is granted a shared app: it is everyone's from the start.
          grantedAt: app.createdAt,
        })),
    ],
  };
}

/** Who opens a shared app is no admin's choice: every member of every organization. */
function assertNotShared(app: { scope: string }): void {
  if (app.scope === "shared") {
    throw new PublicError(
      "SHARED_APP_ACCESS",
      "Every member of every organization can open a shared app; its access can't be changed.",
    );
  }
}

/**
 * Get access state for all users for a specific app.
 * Returns all users with a flag indicating if they have access.
 */
async function getAccessStateForApp(ctx: OrgContext, appRowId: string) {
  const app = await AppRepository.findById(appRowId, ctx.orgId);
  if (app) assertNotShared(app);
  const [allUsers, accessRecords] = await Promise.all([
    OrganizationMembersRepository.listMembersForOrganization(ctx.orgId),
    AppAccessRepository.findAllByAppRowId(appRowId, ctx.orgId),
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
 * Update access for multiple users for an app.
 * Takes the full list of user IDs who should have access.
 * Prevents owners from revoking their own access.
 */
async function updateAccessForApp(
  ctx: OrgContext,
  appRowId: string,
  userIdsWithAccess: string[],
) {
  const app = await AppRepository.findById(appRowId, ctx.orgId);
  if (!app) {
    throw new Error("App not found");
  }
  assertNotShared(app);

  const organizationUsers =
    await OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
  const allowedUserIds = new Set(organizationUsers.map((user) => user.id));
  const validUserIdsWithAccess = userIdsWithAccess.filter((userId) =>
    allowedUserIds.has(userId),
  );

  // Get current access state
  const currentAccess = await AppAccessRepository.findAllByAppRowId(
    appRowId,
    ctx.orgId,
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

    if (id === ctx.userId) {
      return false;
    }

    return true;
  });

  // Grant access to new users
  if (toGrant.length > 0) {
    const accessRecords = toGrant.map((userId) => ({
      id: crypto.randomUUID(),
      organizationId: ctx.orgId,
      userId,
      appRowId,
      grantedBy: ctx.userId,
    }));
    await AppAccessRepository.createMany(accessRecords);
  }

  // Revoke access from removed users
  if (toRevoke.length > 0) {
    await AppAccessRepository.deleteByAppRowAndUsers(
      appRowId,
      toRevoke,
      ctx.orgId,
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
    appRowId: app.id,
    grantedBy: null,
  }));

  await AppAccessRepository.createMany(accessRecords);
}

/**
 * Give the gateway's first owner every app of their organization that
 * nobody has access to: apps deployed before anyone existed, whose initial
 * access found no members to grant.
 */
async function grantUnclaimedAppsToOwner(
  userId: string,
  organizationId: string,
) {
  const unclaimed = await AppRepository.findAllWithoutAccess(organizationId);
  await AppAccessRepository.createMany(
    unclaimed.map((app) => ({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      appRowId: app.id,
      grantedBy: null,
    })),
  );
}

export const AppAccessService = {
  getAppsForUser,
  getAccessStateForApp,
  updateAccessForApp,
  grantDefaultAppsToUser,
  grantUnclaimedAppsToOwner,
} as const;
