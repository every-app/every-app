import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllExerciseLibrary,
  createExerciseLibraryItems,
  updateExerciseLibraryItems,
  deleteExerciseLibraryItems,
} from "@/serverFunctions/exercises";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
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
          data: transaction.mutations.map((mutation) => ({
            id: mutation.modified.id,
            name: mutation.modified.name,
            notes: mutation.modified.notes,
          })),
        });
      },
      onUpdate: async ({ transaction }) => {
        await updateExerciseLibraryItems({
          data: transaction.mutations.map((mutation) => ({
            id: mutation.modified.id,
            name: mutation.modified.name,
            notes: mutation.modified.notes,
          })),
        });
      },
      onDelete: async ({ transaction }) => {
        await deleteExerciseLibraryItems({
          data: transaction.mutations.map((mutation) => ({
            id: mutation.original.id,
          })),
        });
      },
    }),
  ),
);
