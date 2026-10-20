import { env } from "cloudflare:workers";
import { AppRepository } from "../repositories/AppRepository";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";
import { platformPolicy } from "@/server/platform-policy";

// Types for service operations.
// Apps are registered by `everyapp deploy` writing the gateway's D1, never by
// hand. The admin UI can only edit catalog metadata and delete them.
type UpdateAppInput = {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
};

/**
 * Get all apps with user access counts: the organization's own, and on the
 * hosted gateway the shared apps another organization (the platform's)
 * owns, read-only (`readOnly`): only the platform organization's owners and
 * admins edit or delete a shared app, and nobody manages its access.
 */
async function getAllWithAccessCounts(ctx: OrgContext) {
  const [own, shared] = await Promise.all([
    AppRepository.findAllWithAccessCounts(ctx.orgId),
    platformPolicy(env).sharedApps
      ? AppRepository.findAllShared(ctx.orgId)
      : [],
  ]);
  return {
    apps: [
      ...own.map((app) => ({ ...app, readOnly: false })),
      ...shared.map((app) => ({
        id: app.id,
        organizationId: app.organizationId,
        appId: app.appSlug,
        name: app.name,
        description: app.description,
        hostname: app.hostname,
        workerName: app.workerName,
        tier: app.tier,
        scope: app.scope,
        manifest: app.manifest,
        emailSenders: app.emailSenders,
        emailInbound: app.emailInbound,
        status: app.status,
        deployedByActor: app.deployedByActor,
        isDefault: app.isDefault,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        accessCount: 0,
        readOnly: true,
      })),
    ],
  };
}

/**
 * Update an app's catalog metadata. `isDefault` is "Available to everyone":
 * turning it on grants every current member now and every future member on
 * joining; turning it off keeps existing access (remove people with Manage
 * Access).
 */
async function update(ctx: OrgContext, data: UpdateAppInput) {
  const existingApp = await AppRepository.findById(data.id, ctx.orgId);
  if (!existingApp) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }
  // A shared app is no organization's default: it opens for everyone.
  if (existingApp.scope === "shared" && data.isDefault) {
    throw new PublicError(
      "SHARED_APP_ACCESS",
      "Every member of every organization can open a shared app; its access can't be changed.",
    );
  }

  await AppRepository.update(data.id, {
    organizationId: ctx.orgId,
    name: data.name,
    description: data.description,
    isDefault: data.isDefault,
  });

  if (data.isDefault && !existingApp.isDefault) {
    const orgMembers =
      await OrganizationMembersRepository.listMembersForOrganization(ctx.orgId);
    await AppAccessRepository.createMany(
      orgMembers.map((member) => ({
        id: crypto.randomUUID(),
        organizationId: ctx.orgId,
        userId: member.id,
        appRowId: existingApp.id,
        grantedBy: ctx.userId,
      })),
    );
  }
}

/**
 * Delete an app from the catalog: it stops being served and disappears from
 * every list, but its tombstone keeps the slug and worker name reserved to
 * this organization (see AppRepository.tombstone).
 */
async function deleteApp(ctx: OrgContext, id: string) {
  const existingApp = await AppRepository.findById(id, ctx.orgId);
  if (!existingApp) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }

  await AppRepository.tombstone(existingApp);
}

export const AppService = {
  getAllWithAccessCounts,
  update,
  delete: deleteApp,
} as const;
