import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

const QUERY_CACHE_KEY = "every-app-gateway-react-query-cache";

/**
 * Cache buster version - increment this when making breaking changes to:
 * - Database schema (migrations that change data structure)
 * - Collection query keys or data shapes
 * - Any other change that would make cached data incompatible
 *
 * This ensures users don't see stale/incompatible data after updates.
 */
export const CACHE_BUSTER = "v2"; // Bumped for apps/user_app_access schema migration

export const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: QUERY_CACHE_KEY,
});
