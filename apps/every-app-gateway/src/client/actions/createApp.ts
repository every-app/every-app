import { createOptimisticAction } from "@tanstack/react-db";
import { adminAppsCollection, userAppsCollection } from "@/client/tanstack-db";
import { queryClient } from "@/client/tanstack-db/queryClient";
import { createApp } from "@/serverFunctions/apps";
import type { CreateAppFormData } from "@/schemas/app";

type CreateAppParams = CreateAppFormData & {
  id: string; // Pre-generated ID for optimistic update
};

/**
 * Action to create a new app in the catalog.
 * Handles optimistic updates for both admin and user app collections.
 */
export const createAppAction = createOptimisticAction<CreateAppParams>({
  onMutate: ({ id, appId, name, description, appUrl, devUrl, isDefault }) => {
    const now = new Date();
    const session = queryClient.getQueryData<{
      session?: { activeOrganizationId?: string | null };
    } | null>(["auth", "session"]);
    const activeOrganizationId =
      session?.session?.activeOrganizationId ?? "unknown-organization";

    // Optimistically add to admin apps collection
    adminAppsCollection.insert({
      id,
      organizationId: activeOrganizationId,
      appId,
      name,
      description,
      appUrl,
      devUrl: devUrl ?? null,
      isDefault: isDefault ?? false,
      createdAt: now,
      updatedAt: now,
      accessCount: 0, // Will be updated after server sync
    });

    // If grantToAllExisting, we can't optimistically update userAppsCollection
    // because we don't know the current user count. The refetch will handle this.
  },

  mutationFn: async (params) => {
    const { id, ...data } = params;
    await createApp({ data: { ...data, id } });

    // Refetch both collections to sync with server state
    await Promise.all([
      adminAppsCollection.utils.refetch(),
      userAppsCollection.utils.refetch(),
    ]);
  },
});
