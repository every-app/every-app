import { env } from "cloudflare:workers";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { AppRepository } from "../repositories/AppRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { ProviderConnectionRepository } from "../repositories/ProviderConnectionRepository";
import { UsageRepository } from "../repositories/UsageRepository";
import { DrizzleAppRegistry } from "@/perimeter/drizzleAppRegistry";
import { activateBindingApps } from "@/server/app-activation";
import { PublicError } from "@/server/errors";
import { emit } from "@/server/events/bus";
import { catalogue, type EventUser } from "@/server/events/catalogue";
import { actorFor } from "@/server/events/subjects";
import type { OrgContext } from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";
import { listedAppSetup } from "./listedAppSetup";

/**
 * Get all apps a user has access to: the organization's own they open
 * (effective-access.ts; `via` names a group that is their only way in),
 * and on the hosted
 * gateway the shared apps, which every member of every organization may
 * open. Each carries its `setup`: what it still needs set before it
 * opens, with the command for an app of the reader's own organization (a
 * shared app is the platform's to fix), and whether the reader's
 * organization has it `paused`: at its monthly cap on provider calls, in
 * one read for every listed app (a shared app's count and cap are the
 * reader's organization's, whoever owns the row). An app still `binding`
 * is probed first (app-activation.ts): one this gateway reaches is
 * listed active, so the launcher's "Deploying" is never waiting on a
 * visit the person is about to make from it.
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
          everyone: app.everyone,
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
  const [paused, activated] = await Promise.all([
    UsageRepository.pausedApps(
      ctx.orgId,
      listed.map(({ app }) => app.id),
    ),
    activateBindingApps(
      env,
      () => new DrizzleAppRegistry(env.DB),
      listed.map(({ app }) => app),
    ),
  ]);
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
        ...(activated.has(app.id)
          ? { status: "active", updatedAt: new Date() }
          : {}),
        grantedAt,
        via,
        setup: await listedAppSetup(app, app.organizationId === ctx.orgId),
        paused: paused.has(app.id),
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
 * Get access state for all users for a specific app: whether it is
 * available to everyone (`everyone`), and every member, whether they hold
 * a person's grant (`hasAccess`, what the modal edits), whether their role
 * opens it (`admin`: owners and admins open every app) and the groups that
 * grant it to them (`viaGroups`).
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
    everyone: app?.everyone ?? false,
    users: allUsers.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      hasAccess: access.get(user.id)?.direct ?? false,
      admin: access.get(user.id)?.admin ?? false,
      viaGroups: access.get(user.id)?.viaGroups ?? [],
    })),
  };
}

/**
 * Update the person grants to an app: the full list of user IDs who should
 * hold one. What a group grants is never touched here (Admin -> Groups
 * manages that), nor what a role or "Available to everyone" opens.
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

  // Find users to revoke (in current but not in new list). The admin
  // acting keeps the app whatever their own grant: their role opens it.
  const toRevoke = [...currentUserIds].filter((id) => !newUserIds.has(id));

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
    // Their OAuth connections in the app go too, unless another way in
    // still gives them the app.
    await ProviderConnectionRepository.pruneWithoutAccess(ctx.orgId);
  }

  if (toGrant.length > 0 || toRevoke.length > 0) {
    const byId = new Map(
      organizationUsers.map((user): [string, EventUser] => [
        user.id,
        { id: user.id, email: user.email, name: user.name || null },
      ]),
    );
    const named = (id: string): EventUser =>
      byId.get(id) ?? { id, email: null, name: null };
    await emit(async () => ({
      organizationId: ctx.orgId,
      actor: await actorFor(ctx),
      ...catalogue.appAccessChanged({
        app: { id: app.appSlug, rowId: app.id, name: app.name },
        granted: toGrant.map(named),
        revoked: toRevoke.map(named),
      }),
    }));
  }

  return {
    granted: toGrant.length,
    revoked: toRevoke.length,
  };
}

export const AppAccessService = {
  getAppsForUser,
  getAccessStateForApp,
  updateAccessForApp,
} as const;
