import { z } from "zod";

// === Create Workout Exercise ===
export const createWorkoutExerciseSchema = z.object({
  id: z.string(),
  workoutId: z.string(),
  exerciseId: z.string(),
  sets: z.number().min(1).max(20),
  targetReps: z.number().min(1).max(100),
  weight: z.number().nullable().optional(),
  sortOrder: z.number(),
});

// === Update Workout Exercise ===
export const updateWorkoutExerciseSchema = z.object({
  id: z.string(),
  sets: z.number().min(1).max(20).optional(),
  targetReps: z.number().min(1).max(100).optional(),
  weight: z.number().nullable().optional(),
  sortOrder: z.number().optional(),
});

// === Delete Workout Exercise ===
export const deleteWorkoutExerciseSchema = z.object({ id: z.string() });
