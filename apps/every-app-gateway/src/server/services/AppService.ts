import { AppRepository } from "../repositories/AppRepository";
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
 * Update an app's catalog metadata.
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
}

/**
 * Delete an app from the catalog.
 * This cascades and removes all user access records.
 */
async function deleteApp(ctx: OrgContext, id: string) {
  const existingApp = await AppRepository.findById(id, ctx.orgId);
  if (!existingApp) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }

  await AppRepository.delete(id, ctx.orgId);
}

export const AppService = {
  getAllWithAccessCounts,
  update,
  delete: deleteApp,
} as const;
