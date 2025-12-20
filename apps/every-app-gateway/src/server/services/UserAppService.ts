import { UserAppRepository } from "../repositories/UserAppRepository";

// Types for service operations
type CreateUserAppInput = {
  appId: string;
  name: string;
  description: string;
  appUrl: string;
};

type UpdateUserAppInput = {
  id: string;
  name: string;
  description: string;
  appUrl: string;
};

/**
 * Get all apps for a user.
 */
async function getAll(userId: string) {
  const apps = await UserAppRepository.findAllByUserId(userId);
  return { apps };
}

/**
 * Create a new user app.
 * Verifies no duplicate appId exists for this user.
 */
async function create(userId: string, data: CreateUserAppInput) {
  // Check if user already has an app with this appId
  const existingApp = await UserAppRepository.findByAppIdAndUserId(
    data.appId,
    userId,
  );

  if (existingApp) {
    throw new Error("App with this ID already exists");
  }

  const id = crypto.randomUUID();

  await UserAppRepository.create({
    id,
    userId,
    appId: data.appId,
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
  });

  return { appId: id };
}

/**
 * Update a user app.
 * Verifies ownership before updating.
 */
async function update(userId: string, data: UpdateUserAppInput) {
  // Verify ownership
  const existingApp = await UserAppRepository.findByIdAndUserId(
    data.id,
    userId,
  );

  if (!existingApp) {
    throw new Error("App not found or does not belong to user");
  }

  await UserAppRepository.update(data.id, userId, {
    name: data.name,
    description: data.description,
    appUrl: data.appUrl,
  });
}

/**
 * Delete a user app.
 * Verifies ownership before deleting.
 */
async function deleteApp(userId: string, id: string) {
  // Verify ownership
  const existingApp = await UserAppRepository.findByIdAndUserId(id, userId);

  if (!existingApp) {
    throw new Error("App not found or does not belong to user");
  }

  await UserAppRepository.delete(id, userId);
}

/**
 * Get app configuration by appId.
 * Returns null if not found or user doesn't own it.
 */
async function getByAppId(appId: string, userId: string) {
  const userApp = await UserAppRepository.findByAppIdAndUserId(appId, userId);

  if (!userApp) {
    return null;
  }

  return {
    appId: userApp.appId,
    name: userApp.name,
    description: userApp.description,
    appUrl: userApp.appUrl,
    createdAt: userApp.createdAt,
    updatedAt: userApp.updatedAt,
    isUserApp: true,
  };
}

/**
 * Get app configuration by origin URL.
 * Compares the origin against the origin extracted from each app's appUrl,
 * allowing appUrl to contain paths (e.g., "https://app.com/some-path").
 * Returns null if not found or user doesn't own it.
 */
async function getByOrigin(origin: string, userId: string) {
  // Fetch all user apps and compare origins
  // This handles cases where appUrl includes a path
  const userApps = await UserAppRepository.findAllByUserId(userId);

  const userApp = userApps.find((app) => {
    try {
      const appOrigin = new URL(app.appUrl).origin;
      return appOrigin === origin;
    } catch {
      // Invalid URL in appUrl, skip this app
      return false;
    }
  });

  if (!userApp) {
    return null;
  }

  return {
    appId: userApp.appId,
    name: userApp.name,
    description: userApp.description,
    appUrl: userApp.appUrl,
    createdAt: userApp.createdAt,
    updatedAt: userApp.updatedAt,
    isUserApp: true,
  };
}

export const UserAppService = {
  getAll,
  create,
  update,
  delete: deleteApp,
  getByAppId,
  getByOrigin,
} as const;
