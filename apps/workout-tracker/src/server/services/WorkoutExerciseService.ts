import { WorkoutExerciseRepository } from "../repositories/WorkoutExerciseRepository";
import { WorkoutRepository } from "../repositories/WorkoutRepository";
import type {
  CreateWorkoutExerciseInput,
  UpdateWorkoutExerciseInput,
  DeleteWorkoutExerciseInput,
} from "../../types/schemas/workoutExercises";

/**
 * Get all workout exercises for a user.
 */
async function getAll(userId: string) {
  const workoutExercises =
    await WorkoutExerciseRepository.findAllByUserId(userId);
  return { workoutExercises };
}

/**
 * Create multiple workout exercises.
 * Verifies workout ownership before creating.
 */
async function createBatch(
  userId: string,
  items: CreateWorkoutExerciseInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  // Get unique workout IDs and verify ownership
  const workoutIds = [...new Set(items.map((e) => e.workoutId))];

  // Filter through to workouts the user actually owns
  const workoutsWithPrograms = await Promise.all(
    workoutIds.map((id) => WorkoutRepository.findByIdWithProgram(id)),
  );

  const authorizedWorkoutIds = new Set(
    workoutsWithPrograms
      .filter((w) => w?.program.userId === userId)
      .map((w) => w!.id),
  );

  // Verify all exercises belong to authorized workouts
  for (const exercise of items) {
    if (!authorizedWorkoutIds.has(exercise.workoutId)) {
      throw new Error("Workout not found or not authorized");
    }
  }

  // Note: We skip exerciseId ownership verification here because:
  // 1. The exercise library entry may be created in a concurrent request (race condition with optimistic updates)
  // 2. The FK constraint ensures the exercise library item exists
  // 3. Workout ownership provides sufficient authorization - you can only add exercises to your own workouts

  const itemsForRepo = items.map((item) => ({
    id: item.id,
    workoutId: item.workoutId,
    exerciseId: item.exerciseId,
    sets: item.sets,
    targetReps: item.targetReps,
    weight: item.weight ?? null,
    sortOrder: item.sortOrder,
  }));

  await WorkoutExerciseRepository.createBatch(itemsForRepo);
  return { success: true };
}

/**
 * Update multiple workout exercises.
 * Verifies ownership via workout -> program before updating.
 */
async function updateBatch(
  userId: string,
  items: UpdateWorkoutExerciseInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  // Get all exercise IDs and verify ownership
  const exerciseIds = items.map((e) => e.id);
  const existingExercises =
    await WorkoutExerciseRepository.findByIdsWithOwnership(exerciseIds);

  // Build a map of exerciseId -> verified workoutId for defense-in-depth
  const authorizedExerciseWorkoutMap = new Map<string, string>();
  for (const e of existingExercises) {
    if (e.workout.program.userId === userId) {
      authorizedExerciseWorkoutMap.set(e.id, e.workoutId);
    }
  }

  for (const exercise of items) {
    if (!authorizedExerciseWorkoutMap.has(exercise.id)) {
      throw new Error("Exercise not found or not authorized");
    }
  }

  await WorkoutExerciseRepository.updateBatch(
    items,
    authorizedExerciseWorkoutMap,
  );
  return { success: true };
}

/**
 * Delete multiple workout exercises.
 * Verifies ownership via workout -> program before deleting.
 */
async function deleteBatch(
  userId: string,
  items: DeleteWorkoutExerciseInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  const exerciseIds = items.map((e) => e.id);

  // Verify ownership
  const existingExercises =
    await WorkoutExerciseRepository.findByIdsWithOwnership(exerciseIds);

  // Build sets of authorized exercise IDs and workout IDs for defense-in-depth
  const authorizedExerciseIds: string[] = [];
  const authorizedWorkoutIds = new Set<string>();

  for (const e of existingExercises) {
    if (e.workout.program.userId === userId) {
      authorizedExerciseIds.push(e.id);
      authorizedWorkoutIds.add(e.workoutId);
    }
  }

  if (authorizedExerciseIds.length !== exerciseIds.length) {
    throw new Error("Exercise not found or not authorized");
  }

  await WorkoutExerciseRepository.deleteBatch(
    authorizedExerciseIds,
    authorizedWorkoutIds,
  );
  return { success: true };
}

export const WorkoutExerciseService = {
  getAll,
  createBatch,
  updateBatch,
  deleteBatch,
} as const;
