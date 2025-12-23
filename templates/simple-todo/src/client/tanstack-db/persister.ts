import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

const QUERY_CACHE_KEY = "simple-todo-react-query-cache";

export const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: QUERY_CACHE_KEY,
});
