import { userAppsCollection } from "./userAppsCollection";
import { adminUsersCollection } from "./adminUsersCollection";

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
