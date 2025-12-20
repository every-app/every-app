import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllWorkoutExercises,
  createWorkoutExercises,
  updateWorkoutExercises,
  deleteWorkoutExercises,
} from "@/serverFunctions/workoutExercises";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@every-app/sdk/client";
import type { WorkoutExercise } from "@/db/schema";

// This collection manages workout exercises (instances of exercises in workouts)
// For the exercise library (reusable definitions), see exerciseLibraryCollection
export const exercisesCollection = lazyInitForWorkers(() =>
  createCollection(
    queryCollectionOptions<WorkoutExercise, string>({
      queryKey: ["workoutExercises"],
      queryFn: async () => {
        const result = await getAllWorkoutExercises();
        return result.workoutExercises;
      },
      queryClient,
      getKey: (item) => item.id,
      onInsert: async ({ transaction }) => {
        await createWorkoutExercises({
          data: transaction.mutations.map((m) => m.modified),
        });
      },
      onUpdate: async ({ transaction }) => {
        await updateWorkoutExercises({
          data: transaction.mutations.map((m) => m.modified),
        });
      },
      onDelete: async ({ transaction }) => {
        await deleteWorkoutExercises({
          data: transaction.mutations.map((m) => ({ id: m.key as string })),
        });
      },
    }),
  ),
);
