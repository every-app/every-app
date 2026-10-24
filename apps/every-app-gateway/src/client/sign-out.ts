import { authClient } from "@/client/auth-client";
import {
  clearPersistedCache,
  forgetEverything,
  queryClient,
} from "@/client/tanstack-db";

/**
 * Ends the session and forgets everything this browser cached for the
 * person: the cache in memory, the sign-in state included, and its copy in
 * localStorage. The next person to sign in here never sees a flash of the
 * previous one's rows. The caller then leaves the page.
 */
export async function signOutAndForget(): Promise<void> {
  await authClient.signOut();
  forgetEverything(queryClient);
  clearPersistedCache();
}
