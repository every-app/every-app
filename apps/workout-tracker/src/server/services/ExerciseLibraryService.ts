import { ExerciseLibraryRepository } from "../repositories/ExerciseLibraryRepository";
import type {
  CreateExerciseLibraryInput,
  UpdateExerciseLibraryInput,
  DeleteExerciseLibraryInput,
} from "../../types/schemas/exerciseLibrary";

/**
 * Get all exercise library items for a user.
 */
async function getAll(userId: string) {
  const exercises = await ExerciseLibraryRepository.findAllByUserId(userId);
  return { exercises };
}

/**
 * Create multiple exercise library items.
 * Adds userId to each item before creating.
 */
async function createBatch(
  userId: string,
  items: CreateExerciseLibraryInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  const itemsWithUser = items.map((item) => ({
    id: item.id,
    userId,
    name: item.name,
    notes: item.notes ?? null,
  }));

  await ExerciseLibraryRepository.createBatch(itemsWithUser);
  return { success: true };
}

/**
 * Update multiple exercise library items.
 * Verifies ownership before updating.
 */
async function updateBatch(
  userId: string,
  items: UpdateExerciseLibraryInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  // Verify ownership
  const exerciseIds = items.map((e) => e.id);
  const existing = await ExerciseLibraryRepository.findByIdsAndUserId(
    exerciseIds,
    userId,
  );

  const authorizedIds = new Set(existing.map((e) => e.id));
  for (const exercise of items) {
    if (!authorizedIds.has(exercise.id)) {
      throw new Error("Exercise not found or not authorized");
    }
  }

  await ExerciseLibraryRepository.updateBatch(items, userId);
  return { success: true };
}

/**
 * Delete multiple exercise library items.
 * Verifies ownership before deleting.
 * Note: Will fail if any exercise is referenced by workout_exercises.
 */
async function deleteBatch(
  userId: string,
  items: DeleteExerciseLibraryInput[],
) {
  if (items.length === 0) {
    return { success: true };
  }

  const exerciseIds = items.map((e) => e.id);

  // Verify ownership
  const existing = await ExerciseLibraryRepository.findByIdsAndUserId(
    exerciseIds,
    userId,
  );

  if (existing.length !== exerciseIds.length) {
    throw new Error("Exercise not found or not authorized");
  }

  await ExerciseLibraryRepository.deleteBatch(exerciseIds, userId);
  return { success: true };
}

export const ExerciseLibraryService = {
  getAll,
  createBatch,
  updateBatch,
  deleteBatch,
} as const;
