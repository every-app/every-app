import { env } from "cloudflare:workers";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { AppRepository } from "../repositories/AppRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { listedAppSetup } from "./listedAppSetup";

/**
 * Get all apps a user has access to: the organization's own they have
 * installed (directly or through a group, `via`), and on the hosted
 * gateway the shared apps, which every member of every organization may
 * open. Each carries its `setup`: what it still needs set before it
 * opens, with the command for an app of the reader's own organization (a
 * shared app is the platform's to fix).
 */
async function getAppsForUser(ctx: OrgContext) {
  const [accessRecords, shared] = await Promise.all([
    AppAccessRepository.findAllByUserId(ctx.userId, ctx.orgId),
    platformPolicy(env).sharedApps ? AppRepository.findAllShared() : [],
  ]);
  const own = accessRecords.map((record) => ({
    app: record.app,
    grantedAt: record.grantedAt,
    via: record.via,
  }));
  const ownIds = new Set(own.map(({ app }) => app.id));
  const listed = [
    ...own,
    ...shared
      .filter((app) => !ownIds.has(app.id))
      .map((app) => ({
        app: {
          id: app.id,
          organizationId: app.organizationId,
          appId: app.appSlug,
          name: app.name,
          description: app.description,
          hostname: app.hostname,
          scope: app.scope,
          status: app.status,
          icon: app.icon,
          isDefault: app.isDefault,
          createdAt: app.createdAt,
          updatedAt: app.updatedAt,
          tier: app.tier,
          manifest: app.manifest,
          secretNames: app.secretNames,
          versionId: app.versionId,
        },
        // Nobody is granted a shared app: it is everyone's from the start.
        grantedAt: app.createdAt,
        via: null,
      })),
  ];
  const apps = await Promise.all(
    listed.map(async ({ app, grantedAt, via }) => {
      // The registry columns the evaluation read stay server-side; the
      // tier is listed, since a provider app (tier "provider") is shown
      // as its tools rather than a page.
      const {
        manifest: _manifest,
        secretNames: _secretNames,
        versionId: _versionId,
        ...listedApp
      } = app;
      return {
        ...listedApp,
        grantedAt,
        via,
        setup: await listedAppSetup(app, app.organizationId === ctx.orgId),
      };
    }),
  );
  return { apps };
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
 * Get access state for all users for a specific app: every member, whether
 * they hold a direct grant (`hasAccess`, what the modal edits) and the
 * groups that grant it to them (`viaGroups`).
 */
async function getAccessStateForApp(ctx: OrgContext, appRowId: string) {
  const app = await AppRepository.findById(appRowId, ctx.orgId);
  if (app) assertNotShared(app);
  const [allUsers, accessRecords] = await Promise.all([
    OrganizationMembersRepository.listMembersForOrganization(ctx.orgId),
    AppAccessRepository.findAllByAppRowId(appRowId, ctx.orgId),
  ]);

  const access = new Map(accessRecords.map((r) => [r.userId, r]));

  return {
    users: allUsers.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      hasAccess: access.get(user.id)?.direct ?? false,
      viaGroups: access.get(user.id)?.viaGroups ?? [],
    })),
  };
}

/**
 * Update direct access for multiple users for an app.
 * Takes the full list of user IDs who should hold a direct grant; what a
 * group grants is never touched here (Admin -> Groups manages that).
 * Prevents owners from revoking their own access.
 */
async function updateAccessForApp(
  ctx: OrgContext,
  appRowId: string,
  userIdsWithAccess: string[],
) {
  const app = await AppRepository.findById(appRowId, ctx.orgId);
  if (!app) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }
  assertNotShared(app);

  const organizationUsers =
    await OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
  const allowedUserIds = new Set(organizationUsers.map((user) => user.id));
  const validUserIdsWithAccess = userIdsWithAccess.filter((userId) =>
    allowedUserIds.has(userId),
  );

  // The direct grants as they are now; group grants stay as they are.
  const currentAccess = await AppAccessRepository.findAllByAppRowId(
    appRowId,
    ctx.orgId,
  );
  const currentUserIds = new Set(
    currentAccess.filter((r) => r.direct).map((r) => r.userId),
  );
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
