import { createServerFn } from "@tanstack/react-start";
import {
  organizationAdminMiddleware,
  organizationOwnerMiddleware,
  organizationMemberMiddleware,
} from "@/middleware/auth";
import { publicErrorMiddleware } from "@/middleware/publicError";
import { AppService } from "@/server/services/AppService";
import { AppAccessService } from "@/server/services/AppAccessService";
import {
  updateAppSchema,
  deleteAppSchema,
  updateAppAccessSchema,
} from "@/schemas/app";

// ============================================================================
// App Catalog Management (Organization Admin)
// ============================================================================

/**
 * Get all apps in the catalog with access counts.
 * Only accessible by organization admins and owners.
 */
export const getApps = createServerFn()
  .middleware([organizationAdminMiddleware])
  .handler(async ({ context }) => {
    return AppService.getAllWithAccessCounts(context.org);
  });

/**
 * Update an existing app in the catalog.
 * Only accessible by organization admins and owners.
 */
export const updateApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((app: unknown) => updateAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.update(context.org, app);
  });

/**
 * Delete an app from the catalog.
 * Only accessible by organization owner.
 */
export const deleteApp = createServerFn()
  .middleware([publicErrorMiddleware, organizationOwnerMiddleware])
  .inputValidator((app: unknown) => deleteAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.delete(context.org, app.id);
  });

// ============================================================================
// App Access Management (Organization Admin)
// ============================================================================

/**
 * Get access state for all users for a specific app.
 * Returns all users with a flag indicating if they have access.
 * Only accessible by organization admins and owners.
 */
export const getAppAccessState = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((data: unknown) =>
    deleteAppSchema.parse(data),
  ) /* reuse schema with id */
  .handler(async ({ data, context }) => {
    return AppAccessService.getAccessStateForApp(context.org, data.id);
  });

/**
 * Update which users have access to an app.
 * Only accessible by organization admins and owners.
 */
export const updateAppAccess = createServerFn()
  .middleware([publicErrorMiddleware, organizationAdminMiddleware])
  .inputValidator((data: unknown) => updateAppAccessSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppAccessService.updateAccessForApp(
      context.org,
      data.appId,
      data.userIds,
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
    return AppAccessService.getAppsForUser(context.org);
  });
