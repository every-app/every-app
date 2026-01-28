import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { AppWithAccessCount } from "@/types/app";
import { getApps, deleteApp, updateApp } from "@/serverFunctions/apps";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

/**
 * Collection of all apps in the catalog for admin management.
 * Owner-only access.
 */
export const adminAppsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["admin", "apps"],
      queryFn: async () => {
        const result = await getApps();
        return result.apps;
      },
      queryClient,
      getKey: (item: AppWithAccessCount) => item.id,

      // Handle update operations
      onUpdate: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) => {
            const app = mutation.modified as AppWithAccessCount;
            return updateApp({
              data: {
                id: app.id,
                name: app.name,
                description: app.description,
                appUrl: app.appUrl,
                devUrl: app.devUrl,
                isDefault: app.isDefault,
              },
            });
          }),
        );
      },

      // Handle delete operations
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            deleteApp({
              data: { id: (mutation.original as AppWithAccessCount).id },
            }),
          ),
        );
      },

      // Note: Insert is handled via createOptimisticAction,
      // since it may include additional logic (grant to all, etc.)
    }),
  ),
);
