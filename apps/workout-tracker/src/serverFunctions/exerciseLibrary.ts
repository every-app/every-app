import { createServerFn } from "@tanstack/react-start";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";
import { ExerciseLibraryService } from "@/server/services/ExerciseLibraryService";
import {
  batchCreateExerciseLibrarySchema,
  batchUpdateExerciseLibrarySchema,
  batchDeleteExerciseLibrarySchema,
} from "@/types/schemas/exerciseLibrary";

// Get all exercises in user's library
export const getAllExerciseLibrary = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }) => {
    return ExerciseLibraryService.getAll(context.userId);
  });

// Batch create exercise library items
export const createExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchCreateExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return ExerciseLibraryService.createBatch(context.userId, data);
  });

// Batch update exercise library items
export const updateExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchUpdateExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return ExerciseLibraryService.updateBatch(context.userId, data);
  });

// Batch delete exercise library items
export const deleteExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchDeleteExerciseLibrarySchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    return ExerciseLibraryService.deleteBatch(context.userId, data);
  });
