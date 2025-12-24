import { createOptimisticAction } from "@tanstack/react-db";
import { sessionsCollection, programsCollection } from "@/client/tanstack-db";
import { skipToWorkout as skipToWorkoutServerFn } from "@/serverFunctions/sessions";

type SkipToWorkoutParams = {
  programId: string;
  targetWorkoutIndex: number;
  // Optional session to abandon (if there's an in-progress session for current workout)
  sessionIdToAbandon?: string;
};

/**
 * Action to skip to a specific workout in the program.
 * Optionally abandons an in-progress session if one exists.
 */
export const skipToWorkout = createOptimisticAction<SkipToWorkoutParams>({
  onMutate: ({ programId, targetWorkoutIndex, sessionIdToAbandon }) => {
    const now = new Date().toISOString();

    // If there's a session to abandon, mark it as abandoned
    if (sessionIdToAbandon) {
      sessionsCollection.update(sessionIdToAbandon, (draft) => {
        draft.status = "abandoned";
        draft.completedAt = now;
      });
    }

    // Update the program's current workout index
    programsCollection.update(programId, (draft) => {
      draft.currentWorkoutIndex = targetWorkoutIndex;
    });
  },
  mutationFn: async ({ programId, targetWorkoutIndex, sessionIdToAbandon }) => {
    await skipToWorkoutServerFn({
      data: {
        programId,
        targetWorkoutIndex,
        sessionIdToAbandon,
      },
    });

    // Refetch to sync optimistic state with server
    await Promise.all([
      sessionsCollection.utils.refetch(),
      programsCollection.utils.refetch(),
    ]);
  },
});
