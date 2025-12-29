import { createOptimisticAction } from "@tanstack/react-db";
import {
  sessionsCollection,
  programsCollection,
  exercisesCollection,
} from "@/client/tanstack-db";
import { completeWorkoutSession } from "@/serverFunctions/sessions";

type CompleteWorkoutParams = {
  sessionId: string;
  programId: string;
  currentWorkoutIndex: number;
  workoutsCount: number;
};

/**
 * Action to complete a workout session.
 * Atomically marks the session as completed and advances the program to the next workout.
 */
export const completeWorkout = createOptimisticAction<CompleteWorkoutParams>({
  onMutate: ({ sessionId, programId, currentWorkoutIndex, workoutsCount }) => {
    const now = new Date().toISOString();
    const nextIndex = (currentWorkoutIndex + 1) % workoutsCount;

    // Optimistically update the session to completed
    sessionsCollection.update(sessionId, (draft) => {
      draft.status = "completed";
      draft.completedAt = now;
    });

    // Optimistically advance the program to the next workout
    programsCollection.update(programId, (draft) => {
      draft.currentWorkoutIndex = nextIndex;
    });
  },
  mutationFn: async ({
    sessionId,
    programId,
    currentWorkoutIndex,
    workoutsCount,
  }) => {
    const nextIndex = (currentWorkoutIndex + 1) % workoutsCount;

    await completeWorkoutSession({
      data: {
        sessionId,
        programId,
        nextWorkoutIndex: nextIndex,
      },
    });

    // Refetch to sync optimistic state with server
    // exercisesCollection is included because ProgressionService may have updated weights
    await Promise.all([
      sessionsCollection.utils.refetch(),
      programsCollection.utils.refetch(),
      exercisesCollection.utils.refetch(),
    ]);
  },
});
