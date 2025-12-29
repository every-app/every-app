/**
 * Pure progression calculation functions.
 * These functions contain the core logic for weight progression
 * and are independent of database operations.
 */

import { groupBy } from "remeda";
import { DEFAULT_PROGRESSION_INCREMENT } from "./constants";

// ============================================================================
// Types
// ============================================================================

export type SetLogData = {
  exerciseId: string;
  targetReps: number;
  actualReps: number;
  weight: number | null;
};

export type WorkoutExerciseData = {
  id: string;
  exerciseId: string;
  targetReps: number;
  weight: number | null;
  workoutId: string;
};

export type WeightUpdate = {
  id: string;
  exerciseId: string;
  workoutId: string;
  newWeight: number;
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Rounds a weight to the nearest loadable increment (5 lbs).
 * This is the smallest practical weight increment at most gyms.
 */
export function roundToLoadableWeight(weight: number): number {
  return Math.round(weight / 5) * 5;
}

/**
 * Estimates 1-rep max using the Epley formula.
 * e1RM = weight × (1 + reps/30)
 */
export function estimateE1RM(weight: number, reps: number): number {
  if (reps <= 0 || weight <= 0) return 0;
  return weight * (1 + reps / 30);
}

/**
 * Calculates the weight for a given rep count based on e1RM.
 * Inverse of Epley formula: weight = e1RM / (1 + reps/30)
 */
export function calculateWeightForReps(e1RM: number, reps: number): number {
  if (reps <= 0 || e1RM <= 0) return 0;
  return e1RM / (1 + reps / 30);
}

// ============================================================================
// Decision Logic
// ============================================================================

/**
 * Checks if all sets for an exercise hit the target reps.
 */
export function allSetsHitTarget(setLogs: SetLogData[]): boolean {
  if (setLogs.length === 0) return false;
  return setLogs.every((log) => log.actualReps >= log.targetReps);
}

/**
 * Determines which exercises should progress based on set logs.
 * An exercise progresses if all its sets hit the target reps.
 */
export function getExercisesToProgress(setLogs: SetLogData[]): string[] {
  const grouped = groupBy(setLogs, (log) => log.exerciseId);

  return Object.entries(grouped)
    .filter(([, logs]) => allSetsHitTarget(logs))
    .map(([exerciseId]) => exerciseId);
}

// ============================================================================
// Linear Progression
// ============================================================================

/**
 * Calculates new weights for linear progression.
 *
 * Linear progression applies the SAME new weight to ALL workoutExercises
 * that share the same exerciseId, regardless of rep range.
 *
 * The new weight is: max(current weights for exerciseId) + increment
 *
 * @param workoutExercises - All workout exercises to potentially update
 * @param exercisesToProgress - IDs of exercises that should progress (hit all reps)
 * @param incrementMap - Map of exerciseId -> progression increment
 * @returns Array of weight updates to apply
 */
export function calculateLinearProgressionUpdates(
  workoutExercises: WorkoutExerciseData[],
  exercisesToProgress: string[],
  incrementMap: Map<string, number>,
): WeightUpdate[] {
  if (exercisesToProgress.length === 0) return [];

  const exercisesToProgressSet = new Set(exercisesToProgress);

  // Filter to only exercises that should progress
  const relevantExercises = workoutExercises.filter((we) =>
    exercisesToProgressSet.has(we.exerciseId),
  );

  // Find current max weight for each exerciseId
  const exerciseMaxWeights = new Map<string, number>();
  for (const we of relevantExercises) {
    const currentMax = exerciseMaxWeights.get(we.exerciseId) ?? 0;
    if (we.weight !== null && we.weight > currentMax) {
      exerciseMaxWeights.set(we.exerciseId, we.weight);
    }
  }

  // Calculate updates - all exercises with same exerciseId get same new weight
  const updates: WeightUpdate[] = [];
  for (const we of relevantExercises) {
    const increment =
      incrementMap.get(we.exerciseId) ?? DEFAULT_PROGRESSION_INCREMENT;
    const currentMaxWeight =
      exerciseMaxWeights.get(we.exerciseId) ?? we.weight ?? 0;
    const newWeight = roundToLoadableWeight(currentMaxWeight + increment);

    updates.push({
      id: we.id,
      exerciseId: we.exerciseId,
      workoutId: we.workoutId,
      newWeight,
    });
  }

  return updates;
}

// ============================================================================
// Smart Progression
// ============================================================================

/**
 * Calculates new weights for smart progression.
 *
 * Smart progression:
 * 1. Applies a fixed increment to the completed workout's exercise
 * 2. Calculates the e1RM ratio (new/old)
 * 3. Scales other workoutExercises with the same exerciseId by this ratio
 *
 * This means exercises with different rep ranges will get proportionally
 * different weight increases.
 *
 * @param workoutExercises - All workout exercises to potentially update
 * @param exercisesToProgress - IDs of exercises that should progress (hit all reps)
 * @param completedWorkoutId - The workout that was just completed
 * @param incrementMap - Map of exerciseId -> progression increment
 * @returns Array of weight updates to apply
 */
export function calculateSmartProgressionUpdates(
  workoutExercises: WorkoutExerciseData[],
  exercisesToProgress: string[],
  completedWorkoutId: string,
  incrementMap: Map<string, number>,
): WeightUpdate[] {
  if (exercisesToProgress.length === 0) return [];

  const exercisesToProgressSet = new Set(exercisesToProgress);

  // Filter to only exercises that should progress
  const relevantExercises = workoutExercises.filter((we) =>
    exercisesToProgressSet.has(we.exerciseId),
  );

  // Group by exerciseId
  const exerciseGroups = new Map<string, WorkoutExerciseData[]>();
  for (const we of relevantExercises) {
    const existing = exerciseGroups.get(we.exerciseId) ?? [];
    existing.push(we);
    exerciseGroups.set(we.exerciseId, existing);
  }

  const updates: WeightUpdate[] = [];

  for (const [exerciseId, exerciseList] of exerciseGroups) {
    const increment =
      incrementMap.get(exerciseId) ?? DEFAULT_PROGRESSION_INCREMENT;

    // Find the completed workout exercise
    const completedExercise = exerciseList.find(
      (we) => we.workoutId === completedWorkoutId,
    );

    if (!completedExercise || completedExercise.weight === null) {
      // No completed exercise found or no weight set - skip this exercise group
      continue;
    }

    const oldWeight = completedExercise.weight;
    const oldReps = completedExercise.targetReps;
    const newWeight = oldWeight + increment;

    // Calculate e1RM ratio
    const oldE1RM = estimateE1RM(oldWeight, oldReps);
    const newE1RM = estimateE1RM(newWeight, oldReps);
    const ratio = newE1RM / oldE1RM;

    // Apply updates to all exercises in this group
    for (const we of exerciseList) {
      let updatedWeight: number;

      if (we.id === completedExercise.id) {
        // The completed exercise: use direct increment
        updatedWeight = newWeight;
      } else if (we.weight !== null) {
        // Other exercises: scale by ratio and round
        updatedWeight = roundToLoadableWeight(we.weight * ratio);
      } else {
        // No weight set - skip
        continue;
      }

      updates.push({
        id: we.id,
        exerciseId: we.exerciseId,
        workoutId: we.workoutId,
        newWeight: updatedWeight,
      });
    }
  }

  return updates;
}
