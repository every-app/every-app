import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllPrograms,
  createProgram,
  updateProgram,
  deleteProgram,
} from "@/serverFunctions/programs";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/client";
import type { Program } from "@/db/schema";

export const programsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Program, string>({
      queryKey: ["programs"],
      queryFn: async () => {
        const result = await getAllPrograms();
        // Flatten programs by removing nested workouts (collection stores flat data)
        return result.programs.map(({ workouts, ...program }) => program);
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await createProgram({ data: mutation.modified });
        }
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateProgram({ data: mutation.modified });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteProgram({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
