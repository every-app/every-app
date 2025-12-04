import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllSessions,
  createSession,
  updateSession,
  deleteSession,
  type CreateSessionInput,
  type UpdateSessionInput,
} from "@/serverFunctions/sessions";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
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
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified: newSession } = mutation;
          const input: CreateSessionInput = {
            id: newSession.id,
            programId: newSession.programId!,
            workoutId: newSession.workoutId!,
            programNameSnapshot: newSession.programNameSnapshot,
            workoutNameSnapshot: newSession.workoutNameSnapshot,
            status: newSession.status,
          };
          await createSession({ data: input });
        }
      },
      onUpdate: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { modified } = mutation;
          const input: UpdateSessionInput = {
            id: modified.id,
            status: modified.status,
            completedAt: modified.completedAt ?? undefined,
          };
          await updateSession({ data: input });
        }
      },
      onDelete: async ({ transaction }) => {
        // Handle all mutations in the transaction
        for (const mutation of transaction.mutations) {
          const { original } = mutation;
          await deleteSession({ data: { id: original.id } });
        }
      },
    }),
  ),
);
