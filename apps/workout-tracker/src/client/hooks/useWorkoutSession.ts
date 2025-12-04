import { useState, useEffect, useRef, useCallback } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { nanoid } from "nanoid";
import {
  useActiveProgram,
  type WorkoutWithExercises,
  type WorkoutExerciseWithName,
} from "./useProgramData";
import { sessionsCollection, setLogsCollection } from "@/client/tanstack-db";
import { completeWorkout } from "@/client/actions/completeWorkout";
import type { WorkoutSetLog } from "@/db/schema";

/**
 * Spacing factor for sortOrder calculation.
 * Must be larger than max sets per exercise (20) to ensure unique sort orders.
 * Used as: sortOrder = exerciseIndex * SORT_ORDER_SPACING + setIndex
 */
const SORT_ORDER_SPACING = 100;

type WorkoutData = {
  program: {
    id: string;
    name: string;
    currentWorkoutIndex: number;
    workoutsCount: number;
  };
  workout: WorkoutWithExercises;
};

type SetTrackingState = {
  setReps: Record<string, number[]>;
  setTouched: Record<string, boolean[]>;
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
 * Hook to derive set tracking state from setLogs
 * Key insight: setLog exists = touched, no setLog = untouched
 */
export function useSetLogTracking(
  workoutData: WorkoutData | null,
  sessionSetLogs: WorkoutSetLog[],
): SetTrackingState {
  const setReps: Record<string, number[]> = {};
  const setTouched: Record<string, boolean[]> = {};

  if (workoutData?.workout) {
    // Initialize with default values from exercises (all untouched)
    workoutData.workout.exercises.forEach((exercise) => {
      setReps[exercise.id] = Array(exercise.sets).fill(exercise.targetReps);
      setTouched[exercise.id] = Array(exercise.sets).fill(false);
    });

    // Overlay with actual setLog values - if a setLog exists, it's touched
    // Note: exerciseId in setLogs references exerciseLibrary, but we match by
    // looking up the workout exercise that uses that library exercise
    sessionSetLogs.forEach((log) => {
      // Find the workout exercise that matches this log's exerciseId
      const workoutExercise = workoutData.workout.exercises.find(
        (e) => e.exerciseId === log.exerciseId,
      );
      if (workoutExercise && setReps[workoutExercise.id]) {
        const setIndex = log.setNumber - 1; // setNumber is 1-indexed
        if (setIndex >= 0 && setIndex < setReps[workoutExercise.id].length) {
          setReps[workoutExercise.id][setIndex] = log.actualReps;
          setTouched[workoutExercise.id][setIndex] = true; // setLog exists = touched
        }
      }
    });
  }

  return { setReps, setTouched };
}

/**
 * Hook to track workout completion state and provide handlers for rep clicks and workout completion
 */
export function useWorkoutCompletion(
  workoutData: WorkoutData | null,
  sessionId: string | null,
  sessionSetLogs: WorkoutSetLog[],
  setTouched: Record<string, boolean[]>,
) {
  const [isCompleting, setIsCompleting] = useState(false);

  // Completion tracking
  const completedExercises =
    workoutData?.workout.exercises.filter((exercise) => {
      const touched = setTouched[exercise.id] ?? [];
      return touched.length > 0 && touched.every(Boolean);
    }).length ?? 0;

  const totalExercises = workoutData?.workout.exercises.length ?? 0;
  const allComplete =
    completedExercises === totalExercises && totalExercises > 0;

  // Find the setLog for a specific workout exercise and set index
  const findSetLog = useCallback(
    (workoutExercise: WorkoutExerciseWithName, setIndex: number) => {
      return sessionSetLogs.find(
        (log) =>
          log.exerciseId === workoutExercise.exerciseId &&
          log.setNumber === setIndex + 1,
      );
    },
    [sessionSetLogs],
  );

  // Rep click handler - creates setLog on first touch, updates on subsequent clicks
  const handleRepClick = useCallback(
    (workoutExerciseId: string, setIndex: number) => {
      if (!sessionId || !workoutData) return;

      const exercise = workoutData.workout.exercises.find(
        (e) => e.id === workoutExerciseId,
      );
      if (!exercise) return;

      const existingLog = findSetLog(exercise, setIndex);

      if (existingLog) {
        // Already touched - decrement reps (cycle back to target at 0)
        const newReps =
          existingLog.actualReps > 0
            ? existingLog.actualReps - 1
            : exercise.targetReps;
        setLogsCollection.update(existingLog.id, (draft) => {
          draft.actualReps = newReps;
        });
      } else {
        // First touch - create setLog with target reps (confirms the set)
        const exerciseIndex = workoutData.workout.exercises.findIndex(
          (e) => e.id === workoutExerciseId,
        );

        setLogsCollection.insert({
          id: nanoid(),
          sessionId,
          exerciseId: exercise.exerciseId, // Reference to exercise library
          exerciseNameSnapshot: exercise.name, // Snapshot the name at this moment
          setNumber: setIndex + 1,
          targetReps: exercise.targetReps,
          actualReps: exercise.targetReps, // First touch confirms target
          weight: exercise.weight ?? null,
          sortOrder: exerciseIndex * SORT_ORDER_SPACING + setIndex,
        });
      }
    },
    [sessionId, workoutData, findSetLog],
  );

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
    allComplete,
    isCompleting,
    handleRepClick,
    handleCompleteWorkout,
  };
}
