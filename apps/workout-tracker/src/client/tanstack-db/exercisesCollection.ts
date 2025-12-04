import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryClient } from "./queryClient";
import {
  getAllWorkoutExercises,
  createWorkoutExercises,
  updateWorkoutExercises,
  deleteWorkoutExercises,
} from "@/serverFunctions/exercises";
import { createCollection } from "@tanstack/react-db";
import { lazyInitForWorkers } from "@/embedded-sdk/client";
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
          data: transaction.mutations.map((mutation) => ({
            id: mutation.modified.id,
            workoutId: mutation.modified.workoutId,
            exerciseId: mutation.modified.exerciseId,
            sets: mutation.modified.sets,
            targetReps: mutation.modified.targetReps,
            weight: mutation.modified.weight,
            sortOrder: mutation.modified.sortOrder,
          })),
        });
      },
      onUpdate: async ({ transaction }) => {
        await updateWorkoutExercises({
          data: transaction.mutations.map((mutation) => ({
            id: mutation.modified.id,
            sets: mutation.modified.sets,
            targetReps: mutation.modified.targetReps,
            weight: mutation.modified.weight,
            sortOrder: mutation.modified.sortOrder,
          })),
        });
      },
      onDelete: async ({ transaction }) => {
        await deleteWorkoutExercises({
          data: transaction.mutations.map((mutation) => ({
            id: mutation.original.id,
          })),
        });
      },
    }),
  ),
);
