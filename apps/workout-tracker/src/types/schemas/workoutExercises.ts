import { z } from "zod";

// === Create Workout Exercise ===
const createWorkoutExerciseSchema = z.object({
  id: z.string(),
  workoutId: z.string(),
  exerciseId: z.string(),
  sets: z.number().min(1).max(20),
  targetReps: z.number().min(1).max(100),
  weight: z.number().nullable().optional(),
  sortOrder: z.number(),
});

export type CreateWorkoutExerciseInput = z.infer<
  typeof createWorkoutExerciseSchema
>;

// === Batch Create Workout Exercises ===
export const batchCreateWorkoutExercisesSchema = z.array(
  createWorkoutExerciseSchema,
);

// === Update Workout Exercise ===
const updateWorkoutExerciseSchema = z.object({
  id: z.string(),
  sets: z.number().min(1).max(20).optional(),
  targetReps: z.number().min(1).max(100).optional(),
  weight: z.number().nullable().optional(),
  sortOrder: z.number().optional(),
});

export type UpdateWorkoutExerciseInput = z.infer<
  typeof updateWorkoutExerciseSchema
>;

// === Batch Update Workout Exercises ===
export const batchUpdateWorkoutExercisesSchema = z.array(
  updateWorkoutExerciseSchema,
);

// === Delete Workout Exercise ===
const deleteWorkoutExerciseSchema = z.object({ id: z.string() });

export type DeleteWorkoutExerciseInput = z.infer<
  typeof deleteWorkoutExerciseSchema
>;

// === Batch Delete Workout Exercises ===
export const batchDeleteWorkoutExercisesSchema = z.array(
  deleteWorkoutExerciseSchema,
);
