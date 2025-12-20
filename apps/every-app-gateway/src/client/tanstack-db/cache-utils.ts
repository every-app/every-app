import { queryClient } from "./queryClient";

/**
 * Refetches all user-specific collections to ensure fresh data from the server.
 * Called after sign-in/sign-up to load data for the newly authenticated user.
 *
 * Note: We use queryClient.refetchQueries() instead of collection.utils.refetch()
 * because the collection method only syncs with the query cache, it doesn't
 * actually fetch from the server.
 */
export async function refetchCollectionsAfterAuth() {
  await Promise.all([
    queryClient.refetchQueries({ queryKey: ["user-apps"] }),
    queryClient.refetchQueries({ queryKey: ["admin-users"] }),
    queryClient.refetchQueries({ queryKey: ["onboarding"] }),
  ]);
}
