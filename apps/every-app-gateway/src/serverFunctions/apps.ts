import { createServerFn } from "@tanstack/react-start";
import { ownerMiddleware, authMiddleware } from "@/middleware/auth";
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
// App Catalog Management (Owner Only)
// ============================================================================

/**
 * Get all apps in the catalog with access counts.
 * Only accessible by owners.
 */
export const getApps = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .handler(async () => {
    return AppService.getAllWithAccessCounts();
  });

/**
 * Create a new app in the catalog.
 * Only accessible by owners.
 */
export const createApp = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((app: unknown) => createAppSchema.parse(app))
  .handler(async ({ data: app, context }) => {
    return AppService.create(app, context.user.id);
  });

/**
 * Update an existing app in the catalog.
 * Only accessible by owners.
 */
export const updateApp = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((app: unknown) => updateAppSchema.parse(app))
  .handler(async ({ data: app }) => {
    return AppService.update(app);
  });

/**
 * Delete an app from the catalog.
 * Only accessible by owners.
 */
export const deleteApp = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((app: unknown) => deleteAppSchema.parse(app))
  .handler(async ({ data: app }) => {
    return AppService.delete(app.id);
  });

// ============================================================================
// App Access Management (Owner Only)
// ============================================================================

/**
 * Get access state for all users for a specific app.
 * Returns all users with a flag indicating if they have access.
 * Only accessible by owners.
 */
export const getAppAccessState = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((data: unknown) =>
    deleteAppSchema.parse(data),
  ) /* reuse schema with id */
  .handler(async ({ data }) => {
    return AppAccessService.getAccessStateForApp(data.id);
  });

/**
 * Update which users have access to an app.
 * Only accessible by owners.
 */
export const updateAppAccess = createServerFn()
  .middleware([publicErrorMiddleware, ownerMiddleware])
  .inputValidator((data: unknown) => updateAppAccessSchema.parse(data))
  .handler(async ({ data, context }) => {
    return AppAccessService.updateAccessForApp(
      data.appId,
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
  .middleware([publicErrorMiddleware, authMiddleware])
  .handler(async ({ context }) => {
    return AppAccessService.getAppsForUser(context.user.id);
  });
