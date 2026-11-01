import {
  hashKey,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/query-core";

/** The queries the TanStack DB collections sync from. */
export const COLLECTION_QUERY_KEYS: readonly QueryKey[] = [
  ["user-apps"],
  ["admin", "users"],
  ["admin", "apps"],
  ["onboarding"],
];

const COLLECTION_QUERY_HASHES = new Set(
  COLLECTION_QUERY_KEYS.map((queryKey) => hashKey(queryKey)),
);

/** The sign-in state: the session, the sign-in methods, the Access link. */
function isAuthQuery(query: Query): boolean {
  return query.queryKey[0] === "auth";
}

function forget(queryClient: QueryClient, keep: (query: Query) => boolean) {
  const cache = queryClient.getQueryCache();
  for (const query of cache.findAll()) {
    if (keep(query)) continue;
    // A collection whose query is removed deletes its rows and stops
    // watching the cache, and nothing fills it again. Its query is reset
    // instead: pending, without data, until the next refetch; the pages read
    // that as loading (useQueryPending) rather than show the rows it kept.
    if (COLLECTION_QUERY_HASHES.has(query.queryHash)) query.reset();
    else cache.remove(query);
  }
}

/**
 * Forgets every cached answer except the sign-in state: what an organization
 * switch makes stale. A page that mounts again shows its skeleton and
 * fetches. The persisted copy follows the cache.
 */
export function forgetEverythingButAuth(queryClient: QueryClient): void {
  forget(queryClient, isAuthQuery);
}

/** Forgets everything, the sign-in state included: sign-out. */
export function forgetEverything(queryClient: QueryClient): void {
  forget(queryClient, () => false);
}
