import { useCallback, useSyncExternalStore } from "react";
import { notifyManager } from "@tanstack/query-core";
import { queryClient } from "./queryClient";

/**
 * Whether the query behind a collection has no data yet: not built, or
 * pending. A collection keeps its rows while its query is reset (an
 * organization switch, a sign-out), so a page that read only the collection
 * would show the previous organization's rows until the refetch answers.
 * Like useQueryFailed, this reads the query's own state from the shared
 * cache, and re-renders as it changes.
 */
export function useQueryPending(queryKey: readonly unknown[]): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      // Deferred, as useQuery defers its own: a page's query rebuilt during
      // its render (forget removed the old one) notifies the cache mid-render.
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [],
  );
  return useSyncExternalStore(
    subscribe,
    () => {
      const state = queryClient.getQueryState(queryKey);
      return state === undefined || state.status === "pending";
    },
    () => true,
  );
}
