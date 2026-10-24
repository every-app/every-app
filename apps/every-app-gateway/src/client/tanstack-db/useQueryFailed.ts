import { useCallback, useSyncExternalStore } from "react";
import { notifyManager } from "@tanstack/query-core";
import { queryClient } from "./queryClient";

/**
 * Whether the query behind a collection last failed. A query collection
 * (`queryCollectionOptions`) reports no error through `useLiveQuery`: a
 * failed fetch leaves the collection "ready" with whatever it had, so a page
 * that read only `isError` showed a failure as an empty list. This reads the
 * query's own state from the shared cache, and re-renders as it changes.
 */
export function useQueryFailed(queryKey: readonly unknown[]): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      // Deferred, as useQuery defers its own: a page's query rebuilt during
      // its render (forget removed the old one) notifies the cache mid-render.
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [],
  );
  return useSyncExternalStore(
    subscribe,
    () => queryClient.getQueryState(queryKey)?.status === "error",
    () => false,
  );
}
