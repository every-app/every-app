import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

export const persister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "workout-tracker-react-query-cache",
});
