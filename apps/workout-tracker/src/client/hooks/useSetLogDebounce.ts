import { useState, useEffect, useRef, useCallback } from "react";
import { nanoid } from "nanoid";
import { funnel } from "remeda";
import { useSetLogMutations } from "@/client/queries/setLogs";
import type { UpsertSetLogInput } from "@/types/schemas/setLogs";
import type { WorkoutExerciseWithName } from "./useProgramData";
import type { WorkoutSetLog } from "@/db/schema";

const DEBOUNCE_MS = 600;
const SORT_ORDER_SPACING = 100; // Must exceed max sets per exercise (20)

// ============================================
// Types
// ============================================

type SetKey = string;
type PendingSet = { reps: number; logId: string };
type PendingState = Record<SetKey, PendingSet>;

// ============================================
// Pure helpers
// ============================================

const makeSetKey = (exerciseId: string, setIndex: number): SetKey =>
  `${exerciseId}-${setIndex}`;

const findExistingLog = (
  logs: WorkoutSetLog[],
  exerciseId: string,
  setNumber: number,
): WorkoutSetLog | undefined =>
  logs.find(
    (log) => log.exerciseId === exerciseId && log.setNumber === setNumber,
  );

/** First tap → targetReps, subsequent taps → decrement, wrap to targetReps at 0 */
const calculateNextReps = (
  currentReps: number | undefined,
  targetReps: number,
): number => {
  if (currentReps === undefined) return targetReps;
  if (currentReps > 0) return currentReps - 1;
  return targetReps;
};

const persistSetLog = async (
  sessionId: string,
  exercise: WorkoutExerciseWithName,
  exerciseIndex: number,
  setIndex: number,
  reps: number,
  logId: string,
  upsertLog: (data: UpsertSetLogInput) => Promise<unknown>,
) => {
  await upsertLog({
    id: logId,
    sessionId,
    exerciseId: exercise.exerciseId,
    exerciseNameSnapshot: exercise.name,
    setNumber: setIndex + 1,
    targetReps: exercise.targetReps,
    actualReps: reps,
    weight: exercise.weight ?? null,
    sortOrder: exerciseIndex * SORT_ORDER_SPACING + setIndex,
  });
};

// ============================================
// Hook
// ============================================

/**
 * Debounces set log updates during rapid tapping.
 * Provides immediate UI updates via pendingState while batching DB writes.
 */
export function useSetLogDebounce(
  sessionId: string | null,
  exercises: WorkoutExerciseWithName[],
  sessionSetLogs: WorkoutSetLog[],
) {
  const [pendingState, setPendingState] = useState<PendingState>({});
  const { upsert } = useSetLogMutations();

  // Per-set funnels for debouncing
  const funnelsRef = useRef<
    Map<SetKey, { call: (reps: number) => void; cancel: () => void }>
  >(new Map());
  const writeChainsRef = useRef<Map<SetKey, Promise<unknown>>>(new Map());

  useEffect(() => {
    return () => funnelsRef.current.forEach((f) => f.cancel());
  }, []);

  const handleRepClick = useCallback(
    (workoutExerciseId: string, setIndex: number) => {
      if (!sessionId) return;

      const exerciseIndex = exercises.findIndex(
        (e) => e.id === workoutExerciseId,
      );
      const exercise = exercises[exerciseIndex];
      if (!exercise) return;

      const key = makeSetKey(workoutExerciseId, setIndex);
      const existingLog = findExistingLog(
        sessionSetLogs,
        exercise.exerciseId,
        setIndex + 1,
      );
      const pending = pendingState[key];

      // Calculate new state
      const currentReps = pending?.reps ?? existingLog?.actualReps;
      const newReps = calculateNextReps(currentReps, exercise.targetReps);
      const logId = pending?.logId ?? existingLog?.id ?? nanoid();

      // Update UI immediately
      setPendingState((prev) => ({ ...prev, [key]: { reps: newReps, logId } }));

      // Get or create funnel for this set
      let setFunnel = funnelsRef.current.get(key);
      if (!setFunnel) {
        setFunnel = funnel(
          async (data: { reps: number; logId: string }) => {
            const previousWrite =
              writeChainsRef.current.get(key) ?? Promise.resolve();
            const write = previousWrite
              .catch(() => undefined)
              .then(() =>
                persistSetLog(
                  sessionId,
                  exercise,
                  exerciseIndex,
                  setIndex,
                  data.reps,
                  data.logId,
                  upsert.mutateAsync,
                ),
              );
            writeChainsRef.current.set(key, write);

            try {
              await write;
            } catch (error) {
              console.error("Failed to save set log:", error);
            } finally {
              if (writeChainsRef.current.get(key) === write) {
                writeChainsRef.current.delete(key);
              }
              setPendingState((prev) => {
                const pending = prev[key];
                if (
                  !pending ||
                  pending.logId !== data.logId ||
                  pending.reps !== data.reps
                ) {
                  return prev;
                }
                const { [key]: _, ...rest } = prev;
                return rest;
              });
            }
          },
          {
            minQuietPeriodMs: DEBOUNCE_MS,
            reducer: (acc, reps: number) => ({
              reps,
              logId: acc?.logId ?? logId,
            }),
          },
        );
        funnelsRef.current.set(key, setFunnel);
      }

      setFunnel.call(newReps);
    },
    [sessionId, exercises, sessionSetLogs, pendingState, upsert],
  );

  /**
   * Get reps for a specific set. Returns null if untouched, number if touched.
   * Checks pending state first (optimistic UI), then falls back to setLogs.
   */
  const getReps = useCallback(
    (
      workoutExerciseId: string,
      exerciseId: string,
      setIndex: number,
    ): number | null => {
      // Check pending state first
      const pending = pendingState[makeSetKey(workoutExerciseId, setIndex)];
      if (pending) return pending.reps;

      // Check setLogs
      const log = findExistingLog(sessionSetLogs, exerciseId, setIndex + 1);
      return log?.actualReps ?? null;
    },
    [pendingState, sessionSetLogs],
  );

  const hasPendingChanges = Object.keys(pendingState).length > 0;

  return { handleRepClick, getReps, hasPendingChanges };
}
