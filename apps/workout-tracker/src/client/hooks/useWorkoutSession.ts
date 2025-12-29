import { useState, useEffect, useRef, useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { nanoid } from "nanoid";
import { useActiveProgram, type WorkoutWithExercises } from "./useProgramData";
import { useSetLogDebounce } from "./useSetLogDebounce";
import { sessionsCollection, setLogsCollection } from "@/client/tanstack-db";
import { completeWorkout } from "@/client/actions/completeWorkout";
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

  // Live queries for sessions and setLogs
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ session: sessionsCollection }),
  );
  const { data: setLogs } = useLiveQuery((q) =>
    q.from({ setLog: setLogsCollection }),
  );

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
  const hasInitialized = useRef(false);

  // Initialize session when workout loads (but NOT setLogs - those are created on first touch)
  useEffect(() => {
    if (
      !workoutData?.workout ||
      !workoutData?.program ||
      hasInitialized.current
    ) {
      return;
    }

    // Check if we already have an in-progress session
    if (existingSession) {
      // Restore from existing session
      setSessionId(existingSession.id);
      hasInitialized.current = true;
      return;
    }

    // No existing session - create new session only (setLogs created on touch)
    const newSessionId = nanoid();
    setSessionId(newSessionId);
    hasInitialized.current = true;

    const now = new Date().toISOString();

    try {
      // Create the session with snapshot names
      sessionsCollection.insert({
        id: newSessionId,
        userId: "", // Will be set by server
        programId: workoutData.program.id,
        workoutId: workoutData.workout.id,
        programNameSnapshot: workoutData.program.name,
        workoutNameSnapshot: workoutData.workout.name,
        status: "in_progress" as const,
        startedAt: now,
        completedAt: null,
      });
    } catch (error) {
      console.error("Failed to create session:", error);
    }
  }, [workoutData?.workout, workoutData?.program, existingSession, sessions]);

  return {
    workoutData,
    sessionId,
    sessionSetLogs,
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

  // Complete workout handler - uses atomic action for session + program update
  const handleCompleteWorkout = useCallback(
    async (onComplete: () => void) => {
      if (!sessionId || !workoutData) return;

      setIsCompleting(true);
      try {
        // Use the atomic action to complete session and advance program
        await completeWorkout({
          sessionId,
          programId: workoutData.program.id,
          currentWorkoutIndex: workoutData.program.currentWorkoutIndex,
          workoutsCount: workoutData.program.workoutsCount,
        });

        onComplete();
      } catch (error) {
        console.error("Failed to complete workout:", error);
      } finally {
        setIsCompleting(false);
      }
    },
    [sessionId, workoutData],
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
