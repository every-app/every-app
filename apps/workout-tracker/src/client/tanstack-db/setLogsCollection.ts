import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllSetLogs,
  createSetLog,
  updateSetLog,
  deleteSetLog,
  type CreateSetLogInput,
  type UpdateSetLogInput,
} from "@/serverFunctions/setLogs";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
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
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified: newSetLog } = mutation;
          const input: CreateSetLogInput = {
            id: newSetLog.id,
            sessionId: newSetLog.sessionId,
            exerciseId: newSetLog.exerciseId ?? undefined,
            exerciseNameSnapshot: newSetLog.exerciseNameSnapshot,
            setNumber: newSetLog.setNumber,
            targetReps: newSetLog.targetReps,
            actualReps: newSetLog.actualReps,
            weight: newSetLog.weight,
            sortOrder: newSetLog.sortOrder,
          };
          await createSetLog({ data: input });
        }
      },
      onUpdate: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified } = mutation;
          const input: UpdateSetLogInput = {
            id: modified.id,
            actualReps: modified.actualReps,
          };
          await updateSetLog({ data: input });
        }
      },
      onDelete: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { original } = mutation;
          await deleteSetLog({ data: { id: original.id } });
        }
      },
    }),
  ),
);
