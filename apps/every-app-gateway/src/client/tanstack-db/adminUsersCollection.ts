import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import type { AdminUser } from "@/types/admin-user";
import { listUsers, deleteUser } from "@/serverFunctions/admin";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

export const adminUsersCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["admin", "users"],
      queryFn: async () => {
        const result = await listUsers();
        return result.users;
      },
      queryClient,
      getKey: (item: AdminUser) => item.id,

      // Handle delete operations (removing users)
      onDelete: async ({ transaction }) => {
        await Promise.all(
          transaction.mutations.map((mutation) =>
            deleteUser({
              data: { userId: (mutation.original as AdminUser).id },
            }),
          ),
        );
      },

      // Note: onInsert is not implemented because user creation happens via
      // createInviteLink which is a server-side operation that creates both
      // the user and the invite token. After invite creation, we refetch.
    }),
  ),
);
