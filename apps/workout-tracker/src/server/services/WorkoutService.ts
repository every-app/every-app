import { WorkoutRepository } from "../repositories/WorkoutRepository";
import { ProgramRepository } from "../repositories/ProgramRepository";
import type {
  CreateWorkoutInput,
  UpdateWorkoutInput,
} from "@/types/schemas/workouts";

/**
 * Get all workouts for a user.
 */
async function getAll(userId: string) {
  const workouts = await WorkoutRepository.findAllByUserId(userId);
  return { workouts };
}

/**
 * Create multiple workouts.
 * Verifies program ownership before creating.
 */
async function createBatch(userId: string, items: CreateWorkoutInput[]) {
  if (items.length === 0) {
    return { success: true };
  }

  // Get unique program IDs and verify ownership
  const programIds = [...new Set(items.map((w) => w.programId))];

  // Verify ownership of each program
  const programChecks = await Promise.all(
    programIds.map((id) => ProgramRepository.findByIdAndUserId(id, userId)),
  );

  const authorizedProgramIds = new Set(
    programChecks.filter((p) => p !== undefined).map((p) => p!.id),
  );

  for (const workout of items) {
    if (!authorizedProgramIds.has(workout.programId)) {
      throw new Error("Program not found or not authorized");
    }
  }

  const itemsForRepo = items.map((item) => ({
    id: item.id,
    programId: item.programId,
    name: item.name,
    description: item.description,
    sortOrder: item.sortOrder,
  }));

  await WorkoutRepository.createBatch(itemsForRepo);
  return { success: true };
}

/**
 * Update a workout.
 * Verifies ownership via program before updating.
 */
async function update(userId: string, data: UpdateWorkoutInput) {
  // Verify ownership through program
  const workout = await WorkoutRepository.findByIdWithProgram(data.id);

  if (!workout || workout.program.userId !== userId) {
    throw new Error("Workout not found or not authorized");
  }

  const { id, ...updates } = data;
  await WorkoutRepository.update(id, workout.programId, updates);
  return { success: true };
}

/**
 * Delete a workout.
 * Verifies ownership via program before deleting.
 */
async function deleteWorkout(userId: string, id: string) {
  const workout = await WorkoutRepository.findByIdWithProgram(id);

  if (!workout || workout.program.userId !== userId) {
    throw new Error("Workout not found or not authorized");
  }

  await WorkoutRepository.delete(id, workout.programId);
  return { success: true };
}

/**
 * Delete a workout with all its exercises atomically.
 * Verifies ownership via program before deleting.
 */
async function deleteWithExercises(
  userId: string,
  workoutId: string,
  exerciseIds: string[],
) {
  // Verify workout ownership
  const workout = await WorkoutRepository.findByIdWithProgram(workoutId);

  if (!workout || workout.program.userId !== userId) {
    throw new Error("Workout not found or not authorized");
  }

  await WorkoutRepository.deleteWithExercises(
    workoutId,
    workout.programId,
    exerciseIds,
  );
  return { success: true };
}

export const WorkoutService = {
  getAll,
  createBatch,
  update,
  delete: deleteWorkout,
  deleteWithExercises,
} as const;
