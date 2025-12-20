import { queryClient } from "./queryClient";
import { QUERY_CACHE_KEY } from "./persister";
import { userAppsCollection } from "./userAppsCollection";
import { adminUsersCollection } from "./adminUsersCollection";

/**
 * Clears all cached query data from memory and localStorage
 * Should be called on user sign out for security/privacy
 */
export function clearQueryCache() {
  // Clear in-memory cache
  queryClient.clear();

  // Clear localStorage
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(QUERY_CACHE_KEY);
    } catch (error) {
      console.error("Failed to clear localStorage cache:", error);
    }
  }
}

/**
 * Refetches all user-specific collections after sign-in/sign-up.
 * This ensures fresh data is loaded for the newly authenticated user.
 */
export async function refetchCollectionsAfterAuth() {
  await Promise.all([
    userAppsCollection.utils.refetch(),
    adminUsersCollection.utils.refetch(),
  ]);
}
