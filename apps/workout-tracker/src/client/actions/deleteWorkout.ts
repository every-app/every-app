import { createOptimisticAction } from "@tanstack/react-db";
import { workoutsCollection, exercisesCollection } from "@/client/tanstack-db";
import { deleteWorkoutWithExercises } from "@/serverFunctions/workouts";

type DeleteWorkoutParams = {
  workoutId: string;
  exerciseIds: string[];
};

/**
 * Action to delete a workout and all its exercises.
 * Atomically deletes the workout and all associated workout exercises.
 */
export const deleteWorkout = createOptimisticAction<DeleteWorkoutParams>({
  onMutate: ({ workoutId, exerciseIds }) => {
    // Optimistically delete all exercises first (FK constraint order)
    exerciseIds.forEach((id) => {
      exercisesCollection.delete(id);
    });

    // Then optimistically delete the workout
    workoutsCollection.delete(workoutId);
  },
  mutationFn: async ({ workoutId, exerciseIds }) => {
    await deleteWorkoutWithExercises({
      data: {
        workoutId,
        exerciseIds,
      },
    });

    // Refetch to sync optimistic state with server
    await Promise.all([
      workoutsCollection.utils.refetch(),
      exercisesCollection.utils.refetch(),
    ]);
  },
});
