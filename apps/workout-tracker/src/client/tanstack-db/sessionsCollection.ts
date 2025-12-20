import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllSessions,
  createSession,
  updateSession,
  deleteSession,
} from "@/serverFunctions/sessions";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/client";
import type { WorkoutSession } from "@/db/schema";

export const sessionsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<WorkoutSession, string>({
      queryKey: ["sessions"],
      queryFn: async () => {
        const result = await getAllSessions();
        // Flatten sessions by removing nested setLogs (collection stores flat data)
        return result.sessions.map(({ workoutSetLogs, ...session }) => session);
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await createSession({ data: mutation.modified });
        }
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateSession({ data: mutation.modified });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteSession({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
