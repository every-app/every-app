import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

export const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "every-chef-query-cache",
});
