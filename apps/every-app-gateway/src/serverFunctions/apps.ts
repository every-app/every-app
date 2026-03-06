import { createServerFn } from "@tanstack/react-start";
import {
  organizationOwnerMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AppService } from "@/server/services/AppService";
import { AppAccessService } from "@/server/services/AppAccessService";
import {
  createAppSchema,
  updateAppSchema,
  deleteAppSchema,
  updateAppAccessSchema,
} from "@/schemas/app";

// ============================================================================
// App Catalog Management (Organization Owner)
// ============================================================================

/**
 * Get all apps in the catalog with access counts.
 * Only accessible by organization owner.
 */
export const getApps = createServerFn()
  .middleware([organizationOwnerMiddleware])
  .handler(async ({ context }) => {
    return AppService.getAllWithAccessCounts(context.activeOrganizationId);
  });

/**
 * Create a new app in the catalog.
 * Only accessible by organization owner.
 */
export const createApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((app: unknown) => createAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.create(
      app,
      context.activeOrganizationId,
      context.user.id,
    );
  });

/**
 * Update an existing app in the catalog.
 * Only accessible by organization owner.
 */
export const updateApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((app: unknown) => updateAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.update(app, context.activeOrganizationId);
  });

/**
 * Delete an app from the catalog.
 * Only accessible by organization owner.
 */
export const deleteApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((app: unknown) => deleteAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.delete(app.id, context.activeOrganizationId);
  });

// ============================================================================
// App Access Management (Organization Owner)
// ============================================================================

/**
 * Get access state for all users for a specific app.
 * Returns all users with a flag indicating if they have access.
 * Only accessible by organization owner.
 */
export const getAppAccessState = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) =>
    deleteAppSchema.parse(data),
  ) /* reuse schema with id */
  .handler(async ({ data, context }) => {
    return AppAccessService.getAccessStateForApp(
      data.id,
      context.activeOrganizationId,
    );
  });

/**
 * Update which users have access to an app.
 * Only accessible by organization owner.
 */
export const updateAppAccess = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((data: unknown) => updateAppAccessSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppAccessService.updateAccessForApp(
      data.appId,
      context.activeOrganizationId,
      data.userIds,
      context.user.id,
    );
  });

// ============================================================================
// User App Access (Authenticated Users)
// ============================================================================

/**
 * Get all apps the current user has access to.
 * Available to all authenticated users.
 */
export const getMyApps = createServerFn()
  .middleware([organizationMemberMiddleware])
  .handler(async ({ context }) => {
    return AppAccessService.getAppsForUser(
      context.user.id,
      context.activeOrganizationId,
    );
  });
