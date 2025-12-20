import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@every-app/sdk/client";
import { WorkoutExerciseService } from "@/server/services/WorkoutExerciseService";
import {
  batchCreateWorkoutExercisesSchema,
  batchUpdateWorkoutExercisesSchema,
  batchDeleteWorkoutExercisesSchema,
} from "@/types/schemas/workoutExercises";

// Get all workout exercises for user's programs
export const getAllWorkoutExercises = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return WorkoutExerciseService.getAll(context.userId);
  });

// Batch create workout exercises
export const createWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchCreateWorkoutExercisesSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return WorkoutExerciseService.createBatch(context.userId, data);
  });

// Batch update workout exercises
export const updateWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchUpdateWorkoutExercisesSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return WorkoutExerciseService.updateBatch(context.userId, data);
  });

// Batch delete workout exercises
export const deleteWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchDeleteWorkoutExercisesSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return WorkoutExerciseService.deleteBatch(context.userId, data);
  });
