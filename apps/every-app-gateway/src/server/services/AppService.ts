import { AppRepository } from "../repositories/AppRepository";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { PublicError } from "@/server/errors";
import type { OrgContext } from "@/server/organization/orgContext";

// Types for service operations.
// Apps are created by `everyapp deploy` registration, never by hand. The admin
// UI can only edit catalog metadata.
type UpdateAppInput = {
  id: string;
  name?: string;
  description?: string;
  isDefault?: boolean;
};

/**
 * Get all apps with user access counts.
 */
async function getAllWithAccessCounts(ctx: OrgContext) {
  const apps = await AppRepository.findAllWithAccessCounts(ctx.orgId);
  return { apps };
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

  await AppRepository.tombstone(id, ctx.orgId);
}

export const AppService = {
  getAllWithAccessCounts,
  update,
  delete: deleteApp,
} as const;
