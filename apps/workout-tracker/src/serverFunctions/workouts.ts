import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";
import { WorkoutService } from "@/server/services/WorkoutService";
import {
  batchCreateWorkoutsSchema,
  updateWorkoutSchema,
  deleteWorkoutWithExercisesSchema,
} from "@/types/schemas/workouts";

// Get all workouts for user's programs
export const getAllWorkouts = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return WorkoutService.getAll(context.userId);
  });

// Batch create workouts
export const createWorkouts = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => batchCreateWorkoutsSchema.parse(data))
  .handler(async ({ data, context }) => {
    return WorkoutService.createBatch(context.userId, data);
  });

// Update workout
export const updateWorkout = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateWorkoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    return WorkoutService.update(context.userId, data);
  });

// Delete workout
export const deleteWorkout = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    return WorkoutService.delete(context.userId, data.id);
  });

// Delete workout with all its exercises (atomic cascade delete)
export const deleteWorkoutWithExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    deleteWorkoutWithExercisesSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return WorkoutService.deleteWithExercises(
      context.userId,
      data.workoutId,
      data.exerciseIds,
    );
  });
