import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { UserAccessApp } from "@/types/app";
import { getMyApps } from "@/serverFunctions/apps";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

/**
 * Collection of apps the current user has access to.
 * Read-only - app management is done by owners through the admin panel.
 */
export const userAppsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["user-apps"],
      queryFn: async () => {
        const result = await getMyApps();
        return result.apps;
      },
      queryClient,
      getKey: (item: UserAccessApp) => item.id,

      // Note: Insert, update, and delete are not supported.
      // App management is owner-only through the admin panel.
    }),
  ),
);
