import { createOptimisticAction } from "@tanstack/react-db";
import { nanoid } from "nanoid";
import { programsCollection, workoutsCollection } from "@/client/tanstack-db";
import { createCustomProgram as createCustomProgramServerFn } from "@/serverFunctions/programs";

type CreateCustomProgramParams = {
  programId: string;
  workoutId: string;
};

/**
 * Action to create a custom program with an initial workout.
 * Atomically creates the program and a default "Workout 1".
 */
export const createCustomProgram =
  createOptimisticAction<CreateCustomProgramParams>({
    onMutate: ({ programId, workoutId }) => {
      const now = new Date().toISOString();

      // Optimistically insert the program
      programsCollection.insert({
        id: programId,
        userId: "",
        name: "My Custom Program",
        description: "",
        difficulty: "n/a",
        templateId: null,
        currentWorkoutIndex: 0,
        isActive: false,
        progressionMode: "linear",
        createdAt: now,
        updatedAt: now,
      });

      // Optimistically insert the default workout
      workoutsCollection.insert({
        id: workoutId,
        programId,
        name: "Workout 1",
        description: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      });
    },
    mutationFn: async ({ programId, workoutId }) => {
      await createCustomProgramServerFn({
        data: {
          programId,
          workoutId,
        },
      });

      // Refetch to sync optimistic state with server
      await Promise.all([
        programsCollection.utils.refetch(),
        workoutsCollection.utils.refetch(),
      ]);
    },
  });

/**
 * Helper to create the params with pre-generated IDs
 */
export function createCustomProgramParams(): CreateCustomProgramParams {
  return {
    programId: nanoid(),
    workoutId: nanoid(),
  };
}
