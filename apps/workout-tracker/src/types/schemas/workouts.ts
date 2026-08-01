import { z } from "zod";
import {
  createWorkoutExerciseSchema,
  deleteWorkoutExerciseSchema,
  updateWorkoutExerciseSchema,
} from "./workoutExercises";

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
  description: z.string().nullable().optional(),
  sortOrder: z.number().optional(),
});

export type UpdateWorkoutInput = z.infer<typeof updateWorkoutSchema>;

// === Save Workout Edits ===
export const saveWorkoutEditsSchema = z.object({
  workout: z.object({
    id: z.string(),
    name: z.string().min(1),
    description: z.string().nullable(),
  }),
  create: z.array(createWorkoutExerciseSchema),
  update: z.array(updateWorkoutExerciseSchema),
  remove: z.array(deleteWorkoutExerciseSchema),
  libraryUpdates: z.array(
    z.object({
      id: z.string(),
      progressionIncrement: z.number(),
    }),
  ),
});

export type SaveWorkoutEditsInput = z.infer<typeof saveWorkoutEditsSchema>;

// === Delete Workout With Exercises ===
export const deleteWorkoutWithExercisesSchema = z.object({
  workoutId: z.string(),
  exerciseIds: z.array(z.string()),
});

export type DeleteWorkoutWithExercisesInput = z.infer<
  typeof deleteWorkoutWithExercisesSchema
>;
