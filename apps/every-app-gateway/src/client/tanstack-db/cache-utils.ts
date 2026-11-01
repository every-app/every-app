import { ACTIVE_ORGANIZATION_QUERY_KEY } from "@/client/hooks/useActiveOrganization";
import { queryClient } from "./queryClient";
import { userAppsCollection } from "./userAppsCollection";
import { onboardingCollection } from "./onboardingCollection";
import { adminUsersCollection } from "./adminUsersCollection";
import { adminAppsCollection } from "./adminAppsCollection";
import { COLLECTION_QUERY_KEYS } from "./forget";

/**
 * Refetches all user-specific collections to ensure fresh data from the server.
 * Called after sign-in/sign-up to load data for the newly authenticated user.
 *
 * Note: We use queryClient.refetchQueries() instead of collection.utils.refetch()
 * because the collection method only syncs with the query cache, it doesn't
 * actually fetch from the server.
 *
 * Important: We access each collection before refetching to ensure they are
 * initialized (they use lazy initialization via lazyInitForWorkers). Without
 * this, refetchQueries would fail with "Missing queryFn" if the collection
 * hasn't been accessed yet.
 */
export async function refetchCollectionsAfterAuth() {
  // Access collections to ensure they're initialized before refetching
  void userAppsCollection.state;
  void onboardingCollection.state;
  void adminUsersCollection.state;
  void adminAppsCollection.state;

  await Promise.all([
    ...COLLECTION_QUERY_KEYS.map((queryKey) =>
      queryClient.refetchQueries({ queryKey }),
    ),
    queryClient.invalidateQueries({ queryKey: ACTIVE_ORGANIZATION_QUERY_KEY }),
  ]);
}
