import { useState, useEffect, useRef, useCallback } from "react";
import { nanoid } from "nanoid";
import { useActiveProgram, type WorkoutWithExercises } from "./useProgramData";
import { useSetLogDebounce } from "./useSetLogDebounce";
import { useSessionMutations, useSessions } from "@/client/queries/sessions";
import { useSetLogs } from "@/client/queries/setLogs";
import type { WorkoutSetLog } from "@/db/schema";

type WorkoutData = {
  program: {
    id: string;
    name: string;
    currentWorkoutIndex: number;
    workoutsCount: number;
  };
  workout: WorkoutWithExercises;
};

/**
 * Hook to manage workout session lifecycle - creates or restores a session for the current workout
 */
export function useWorkoutSession() {
  const { activeProgram } = useActiveProgram();

  const {
    data: sessions,
    error: sessionsError,
    isPending: areSessionsPending,
    refetch: refetchSessions,
  } = useSessions();
  const { data: setLogs } = useSetLogs();
  const { create } = useSessionMutations();

  // Build current workout data from active program
  const currentWorkout = activeProgram
    ? activeProgram.workouts[activeProgram.currentWorkoutIndex]
    : null;

  const workoutData: WorkoutData | null =
    activeProgram && currentWorkout
      ? {
          program: {
            id: activeProgram.id,
            name: activeProgram.name,
            currentWorkoutIndex: activeProgram.currentWorkoutIndex,
            workoutsCount: activeProgram.workouts.length,
          },
          workout: currentWorkout,
        }
      : null;

  // Find existing in-progress session for this workout
  const existingSession = workoutData?.workout
    ? (sessions?.find(
        (s) =>
          s.workoutId === workoutData.workout.id && s.status === "in_progress",
      ) ?? null)
    : null;

  // Get setLogs for the current session
  const sessionSetLogs = existingSession
    ? (setLogs ?? []).filter((log) => log.sessionId === existingSession.id)
    : [];

  // Track the current session ID
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionCreationError, setSessionCreationError] =
    useState<Error | null>(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const attemptedWorkoutKey = useRef<string | null>(null);

  // Initialize session when workout loads (but NOT setLogs - those are created on first touch)
  useEffect(() => {
    if (
      !workoutData?.workout ||
      !workoutData?.program ||
      areSessionsPending ||
      sessionsError
    ) {
      return;
    }

    const workoutKey = `${workoutData.program.id}:${workoutData.workout.id}`;

    // Check if we already have an in-progress session
    if (existingSession) {
      // Restore from existing session
      setSessionId(existingSession.id);
      setSessionCreationError(null);
      attemptedWorkoutKey.current = workoutKey;
      return;
    }

    if (attemptedWorkoutKey.current === workoutKey) return;

    // No existing session - create new session only (setLogs created on touch)
    const newSessionId = nanoid();
    attemptedWorkoutKey.current = workoutKey;
    setSessionId(newSessionId);
    setSessionCreationError(null);

    void create
      .mutateAsync({
        id: newSessionId,
        programId: workoutData.program.id,
        workoutId: workoutData.workout.id,
        programNameSnapshot: workoutData.program.name,
        workoutNameSnapshot: workoutData.workout.name,
        status: "in_progress",
      })
      .catch((error) => {
        console.error("Failed to create session:", error);
        setSessionId(null);
        setSessionCreationError(
          error instanceof Error
            ? error
            : new Error("Failed to create session"),
        );
      });
  }, [
    workoutData?.workout,
    workoutData?.program,
    existingSession,
    areSessionsPending,
    sessionsError,
    create,
    retryAttempt,
  ]);

  const retrySessionCreation = useCallback(async () => {
    const result = await refetchSessions();
    if (result.error) return;

    attemptedWorkoutKey.current = null;
    setSessionCreationError(null);
    setRetryAttempt((attempt) => attempt + 1);
  }, [refetchSessions]);

  const sessionError =
    sessionCreationError ??
    (sessionsError instanceof Error ? sessionsError : null);

  return {
    workoutData,
    sessionId,
    sessionSetLogs,
    sessionError,
    isSessionInitializing: areSessionsPending || create.isPending,
    retrySessionCreation,
  };
}

/**
 * Hook to track workout completion state and provide handlers for rep clicks and workout completion
 */
export function useWorkoutCompletion(
  workoutData: WorkoutData | null,
  sessionId: string | null,
  sessionSetLogs: WorkoutSetLog[],
) {
  const [isCompleting, setIsCompleting] = useState(false);
  const { complete } = useSessionMutations();

  // Use extracted debounce hook for rep click handling
  const { handleRepClick, getReps, hasPendingChanges } = useSetLogDebounce(
    sessionId,
    workoutData?.workout.exercises ?? [],
    sessionSetLogs,
  );

  // Completion tracking - an exercise is complete when all its sets are touched
  const completedExercises =
    workoutData?.workout.exercises.filter((exercise) => {
      for (let i = 0; i < exercise.sets; i++) {
        if (getReps(exercise.id, exercise.exerciseId, i) === null) return false;
      }
      return true;
    }).length ?? 0;

  const totalExercises = workoutData?.workout.exercises.length ?? 0;

  // Check if any sets have been logged (enables early finish)
  const hasAnyProgress = sessionSetLogs.length > 0 || hasPendingChanges;

  // Complete workout handler - one server function updates session + program.
  const handleCompleteWorkout = useCallback(
    async (onComplete: () => void) => {
      if (!sessionId || !workoutData) return;

      setIsCompleting(true);
      try {
        await complete.mutateAsync({
          sessionId,
          programId: workoutData.program.id,
          nextWorkoutIndex:
            (workoutData.program.currentWorkoutIndex + 1) %
            workoutData.program.workoutsCount,
        });

        onComplete();
      } catch (error) {
        console.error("Failed to complete workout:", error);
      } finally {
        setIsCompleting(false);
      }
    },
    [complete, sessionId, workoutData],
  );

  return {
    completedExercises,
    totalExercises,
    hasAnyProgress,
    isCompleting,
    handleRepClick,
    handleCompleteWorkout,
    getReps,
  };
}
