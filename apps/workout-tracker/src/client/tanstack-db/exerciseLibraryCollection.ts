import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllExerciseLibrary,
  createExerciseLibraryItems,
  updateExerciseLibraryItems,
  deleteExerciseLibraryItems,
} from "@/serverFunctions/exerciseLibrary";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/client";
import type { ExerciseLibraryItem } from "@/db/schema";

export const exerciseLibraryCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<ExerciseLibraryItem, string>({
      queryKey: ["exerciseLibrary"],
      queryFn: async () => {
        const result = await getAllExerciseLibrary();
        return result.exercises;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        await createExerciseLibraryItems({
          data: transaction.mutations.map((m) => m.modified),
        });
      },
      onUpdate: async ({ transaction }) => {
        await updateExerciseLibraryItems({
          data: transaction.mutations.map((m) => m.modified),
        });
      },
      onDelete: async ({ transaction }) => {
        await deleteExerciseLibraryItems({
          data: transaction.mutations.map((m) => ({ id: m.key as string })),
        });
      },
    }),
  ),
);
