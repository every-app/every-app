import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { UserApp } from "@/types/user-app";
import {
  createUserApp,
  getUserApps,
  deleteUserApp,
  updateUserApp,
} from "@/serverFunctions/user-apps";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

export const userAppsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["user-apps"],
      queryFn: async () => {
        const result = await getUserApps();
        return result.apps;
      },
      queryClient,
      getKey: (item: UserApp) => item.id,

      // Handle insert operations (adding new apps)
      onInsert: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            createUserApp({ data: mutation.modified }),
          ),
        );
      },

      // Handle delete operations (removing apps)
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            deleteUserApp({ data: { id: (mutation.original as UserApp).id } }),
          ),
        );
      },

      // Handle update operations (editing apps)
      onUpdate: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            updateUserApp({
              data: {
                id: mutation.modified.id,
                name: mutation.modified.name,
                description: mutation.modified.description,
                appUrl: mutation.modified.appUrl,
                devUrl: mutation.modified.devUrl,
              },
            }),
          ),
        );
      },
    }),
  ),
);
