import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { toast } from "sonner";
import { queryClient } from "./queryClient";
import type { AdminUser } from "@/types/admin-user";
import { listMembers, deleteUser } from "@/serverFunctions/admin";
import { lazyInitForWorkers } from "@/utils/lazyInitForWorkers";

export const adminUsersCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions({
      queryKey: ["admin", "users"],
      queryFn: async () => {
        const result = await listMembers();
        return result.users;
      },
      queryClient,
      getKey: (item: AdminUser) => item.id,

      // Handle delete operations (removing users)
      onDelete: async ({ transaction }) => {
        const results = await Promise.all(
          transaction.mutations.map((mutation) =>
            deleteUser({
              data: { userId: (mutation.original as AdminUser).id },
            }),
          ),
        );
        // Someone Cloudflare Access would let straight back in is
        // deactivated instead; the refetch shows them again, deactivated.
        if (results.some((result) => result.deactivatedInstead)) {
          toast.info(
            "Deactivated instead of deleted: Cloudflare Access would let them straight back in.",
          );
        }
      },

      // Note: onInsert is not implemented because invitations are created via
      // server-side Better Auth APIs. After inviting a member, we refetch.
    }),
  ),
);
