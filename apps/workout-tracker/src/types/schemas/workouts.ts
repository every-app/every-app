import { z } from "zod";

// === Create Workout ===
const createWorkoutSchema = z.object({
  id: z.string(),
  programId: z.string(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  sortOrder: z.number(),
});

export type CreateWorkoutInput = z.infer<typeof createWorkoutSchema>;

// === Batch Create Workouts ===
export const batchCreateWorkoutsSchema = z.array(createWorkoutSchema);

// === Update Workout ===
export const updateWorkoutSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  sortOrder: z.number().optional(),
});

export type UpdateWorkoutInput = z.infer<typeof updateWorkoutSchema>;

// === Delete Workout With Exercises ===
export const deleteWorkoutWithExercisesSchema = z.object({
  workoutId: z.string(),
  exerciseIds: z.array(z.string()),
});
