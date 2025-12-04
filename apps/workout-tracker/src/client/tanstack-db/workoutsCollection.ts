import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllWorkouts,
  createWorkouts,
  updateWorkout,
  deleteWorkout,
} from "@/serverFunctions/workouts";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
import type { Workout } from "@/db/schema";

export const workoutsCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<Workout, string>({
      queryKey: ["workouts"],
      queryFn: async () => {
        const result = await getAllWorkouts();
        return result.workouts;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        await createWorkouts({
          data: transaction.mutations.map((m) => m.modified),
        });
      },
      onUpdate: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await updateWorkout({ data: mutation.modified });
        }
      },
      onDelete: async ({ transaction }) => {
        for (const mutation of transaction.mutations) {
          await deleteWorkout({ data: { id: mutation.key as string } });
        }
      },
    }),
  ),
);
