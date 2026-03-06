import { AppRepository } from "../repositories/AppRepository";
import { AppAccessRepository } from "../repositories/AppAccessRepository";
import { OrganizationMembersRepository } from "../repositories/OrganizationMembersRepository";
import { isValidAppOrigin } from "@/utils/origin-validator";
import { PublicError } from "@/server/errors";

// Types for service operations
type CreateAppInput = {
  id?: string; // Optional pre-generated ID for optimistic updates
  appId: string;
  name: string;
  description: string;
  appUrl: string;
  devUrl?: string | null;
  isDefault?: boolean;
  grantToAllExisting?: boolean;
};

type UpdateAppInput = {
  id: string;
  name?: string;
  description?: string;
  appUrl?: string;
  devUrl?: string | null;
  isDefault?: boolean;
};

/**
 * Get all apps in the catalog.
 */
async function getAll(organizationId: string) {
  const allApps = await AppRepository.findAll(organizationId);
  return { apps: allApps };
}

/**
 * Get all apps with user access counts.
 */
async function getAllWithAccessCounts(organizationId: string) {
  const apps = await AppRepository.findAllWithAccessCounts(organizationId);
  return { apps };
}

/**
 * Get a single app by ID.
 */
async function getById(id: string, organizationId: string) {
  const app = await AppRepository.findById(id, organizationId);
  if (!app) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }
  return { app };
}

/**
 * Get a single app by appId (slug).
 */
async function getByAppId(appId: string, organizationId: string) {
  const app = await AppRepository.findByAppId(appId, organizationId);
  if (!app) {
    return null;
  }
  return app;
}

/**
 * Create a new app in the catalog.
 * Always grants access to the creating user (owner).
 * Optionally grant access to all existing users.
 */
async function create(
  data: CreateAppInput,
  organizationId: string,
  grantedBy?: string,
) {
  // Check if app with this appId already exists
  const existingApp = await AppRepository.findByAppId(
    data.appId,
    organizationId,
  );
  if (existingApp) {
    throw new PublicError(
      "APP_ID_ALREADY_EXISTS",
      "App with this ID already exists",
    );
  }

  // Use provided ID or generate a new one
  const id = data.id ?? crypto.randomUUID();

  await AppRepository.create({
    id,
    organizationId,
    appId: data.appId,
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
    devUrl: data.devUrl,
    isDefault: data.isDefault,
  });

  // If requested, grant access to all existing users
  if (data.grantToAllExisting) {
    const allUsers =
      await OrganizationMembersRepository.listMembersForOrganization(
        organizationId,
      );
    const accessRecords = allUsers.map((user) => ({
      id: crypto.randomUUID(),
      organizationId,
      userId: user.id,
      appId: id,
      grantedBy,
    }));

    await AppAccessRepository.createMany(accessRecords);
  } else if (grantedBy) {
    // Always grant access to the creating owner
    await AppAccessRepository.create({
      id: crypto.randomUUID(),
      organizationId,
      userId: grantedBy,
      appId: id,
      grantedBy,
    });
  }

  return { id };
}

/**
 * Update an app in the catalog.
 */
async function update(data: UpdateAppInput, organizationId: string) {
  const existingApp = await AppRepository.findById(data.id, organizationId);
  if (!existingApp) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }

  await AppRepository.update(data.id, {
    organizationId,
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
    devUrl: data.devUrl,
    isDefault: data.isDefault,
  });
}

/**
 * Delete an app from the catalog.
 * This cascades and removes all user access records.
 */
async function deleteApp(id: string, organizationId: string) {
  const existingApp = await AppRepository.findById(id, organizationId);
  if (!existingApp) {
    throw new PublicError("APP_NOT_FOUND", "App not found");
  }

  await AppRepository.delete(id, organizationId);
}

/**
 * App configuration needed for token generation and origin validation.
 */
type AppConfigForToken = {
  appId: string;
  appUrl: string;
  devUrl: string | null;
};

/**
 * Get app configuration by origin URL for a user.
 * Verifies user has access to the app.
 */
async function getByOriginForUser(
  origin: string,
  userId: string,
  organizationId: string,
): Promise<AppConfigForToken | null> {
  // Get all apps user has access to
  const userAccessRecords = await AppAccessRepository.findAllByUserId(
    userId,
    organizationId,
  );

  // Find app matching the origin
  const matchingAccess = userAccessRecords.find((access) =>
    isValidAppOrigin(origin, access.app.appUrl, access.app.devUrl),
  );

  if (!matchingAccess) {
    return null;
  }

  return {
    appId: matchingAccess.app.appId,
    appUrl: matchingAccess.app.appUrl,
    devUrl: matchingAccess.app.devUrl,
  };
}

/**
 * Get app configuration by appId (slug) for a user.
 * Verifies user has access to the app.
 */
async function getByAppIdForUser(
  appId: string,
  userId: string,
  organizationId: string,
): Promise<AppConfigForToken | null> {
  const access = await AppAccessRepository.findByUserAndAppSlug(
    userId,
    appId,
    organizationId,
  );

  if (!access) {
    return null;
  }

  return {
    appId: access.app.appId,
    appUrl: access.app.appUrl,
    devUrl: access.app.devUrl,
  };
}

export const AppService = {
  getAll,
  getAllWithAccessCounts,
  getById,
  getByAppId,
  create,
  update,
  delete: deleteApp,
  getByOriginForUser,
  getByAppIdForUser,
} as const;
