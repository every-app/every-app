import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllSetLogs,
  createSetLog,
  updateSetLog,
  deleteSetLog,
} from "@/serverFunctions/setLogs";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/client";
import type { WorkoutSetLog } from "@/db/schema";

export const setLogsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<WorkoutSetLog, string>({
      queryKey: ["setLogs"],
      queryFn: async () => {
        const result = await getAllSetLogs();
        return result.setLogs;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await createSetLog({ data: mutation.modified });
        }
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateSetLog({ data: mutation.modified });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteSetLog({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
