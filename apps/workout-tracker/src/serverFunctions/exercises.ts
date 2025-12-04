import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db";
import {
  exerciseLibrary,
  workoutExercises,
  workouts,
  programs,
} from "@/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import {
  ensureUserMiddleware,
  type AuthenticatedContext,
} from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";

// ==========================================
// EXERCISE LIBRARY (global exercise definitions)
// ==========================================

// Get all exercises in user's library
export const getAllExerciseLibrary = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const exercises = await db.query.exerciseLibrary.findMany({
      where: eq(exerciseLibrary.userId, context.userId),
    });
    return { exercises };
  });

// Create exercise library item schema
const createExerciseLibrarySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  notes: z.string().nullable().optional(),
});

type CreateExerciseLibraryInput = z.infer<typeof createExerciseLibrarySchema>;

// Batch create exercise library items
const batchCreateExerciseLibrarySchema = z.array(createExerciseLibrarySchema);

export const createExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchCreateExerciseLibrarySchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateExerciseLibraryInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      const now = new Date().toISOString();

      // Use Drizzle's batch API to insert each row as a separate statement
      // This avoids D1's SQL variable limit while keeping everything in one transaction
      const insertStatements = data.map((e) =>
        db.insert(exerciseLibrary).values({
          id: e.id,
          userId: context.userId,
          name: e.name,
          notes: e.notes ?? null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (insertStatements.length > 0) {
        const [first, ...rest] = insertStatements;
        await db.batch([first, ...rest]);
      }

      return { success: true };
    },
  );

// Update exercise library item schema
const updateExerciseLibrarySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  notes: z.string().nullable().optional(),
});

type UpdateExerciseLibraryInput = z.infer<typeof updateExerciseLibrarySchema>;

// Batch update exercise library items
const batchUpdateExerciseLibrarySchema = z.array(updateExerciseLibrarySchema);

export const updateExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchUpdateExerciseLibrarySchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateExerciseLibraryInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      // Verify ownership
      const exerciseIds = data.map((e) => e.id);
      const existing = await db.query.exerciseLibrary.findMany({
        where: and(
          inArray(exerciseLibrary.id, exerciseIds),
          eq(exerciseLibrary.userId, context.userId),
        ),
      });

      const authorizedIds = new Set(existing.map((e) => e.id));
      for (const exercise of data) {
        if (!authorizedIds.has(exercise.id)) {
          throw new Error("Exercise not found or not authorized");
        }
      }

      const now = new Date().toISOString();
      await Promise.all(
        data.map((exercise) => {
          const { id, ...updates } = exercise;
          return db
            .update(exerciseLibrary)
            .set({ ...updates, updatedAt: now })
            .where(
              and(
                eq(exerciseLibrary.id, id),
                eq(exerciseLibrary.userId, context.userId),
              ),
            );
        }),
      );

      return { success: true };
    },
  );

// Delete exercise library item schema
const deleteExerciseLibrarySchema = z.object({ id: z.string() });

type DeleteExerciseLibraryInput = z.infer<typeof deleteExerciseLibrarySchema>;

// Batch delete exercise library items
const batchDeleteExerciseLibrarySchema = z.array(deleteExerciseLibrarySchema);

export const deleteExerciseLibraryItems = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchDeleteExerciseLibrarySchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: DeleteExerciseLibraryInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      const exerciseIds = data.map((e) => e.id);

      // Verify ownership
      const existing = await db.query.exerciseLibrary.findMany({
        where: and(
          inArray(exerciseLibrary.id, exerciseIds),
          eq(exerciseLibrary.userId, context.userId),
        ),
      });

      const authorizedIds = existing.map((e) => e.id);
      if (authorizedIds.length !== exerciseIds.length) {
        throw new Error("Exercise not found or not authorized");
      }

      // Note: This will fail with RESTRICT if exercise is used in any workout
      await db
        .delete(exerciseLibrary)
        .where(
          and(
            inArray(exerciseLibrary.id, authorizedIds),
            eq(exerciseLibrary.userId, context.userId),
          ),
        );

      return { success: true };
    },
  );

// ==========================================
// WORKOUT EXERCISES (exercise instances in workouts)
// ==========================================

// Get all workout exercises for user's programs
export const getAllWorkoutExercises = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const result = await db
      .select({ workoutExercise: workoutExercises })
      .from(workoutExercises)
      .innerJoin(workouts, eq(workoutExercises.workoutId, workouts.id))
      .innerJoin(programs, eq(workouts.programId, programs.id))
      .where(eq(programs.userId, context.userId));

    return { workoutExercises: result.map((r) => r.workoutExercise) };
  });

// Create workout exercise schema
const createWorkoutExerciseSchema = z.object({
  id: z.string(),
  workoutId: z.string(),
  exerciseId: z.string(),
  sets: z.number().min(1).max(20),
  targetReps: z.number().min(1).max(100),
  weight: z.number().nullable().optional(),
  sortOrder: z.number(),
});

type CreateWorkoutExerciseInput = z.infer<typeof createWorkoutExerciseSchema>;

// Batch create workout exercises
const batchCreateWorkoutExercisesSchema = z.array(createWorkoutExerciseSchema);

export const createWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchCreateWorkoutExercisesSchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateWorkoutExerciseInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      // Get unique workout IDs and verify ownership
      const workoutIds = [...new Set(data.map((e) => e.workoutId))];
      const userWorkouts = await db.query.workouts.findMany({
        where: inArray(workouts.id, workoutIds),
        with: { program: true },
      });

      const authorizedWorkoutIds = new Set(
        userWorkouts
          .filter((w) => w.program.userId === context.userId)
          .map((w) => w.id),
      );

      // Verify all exercises belong to authorized workouts
      for (const exercise of data) {
        if (!authorizedWorkoutIds.has(exercise.workoutId)) {
          throw new Error("Workout not found or not authorized");
        }
      }

      // Note: We skip exerciseId ownership verification here because:
      // 1. The exercise library entry may be created in a concurrent request (race condition with optimistic updates)
      // 2. The FK constraint ensures the exercise library item exists
      // 3. Workout ownership provides sufficient authorization - you can only add exercises to your own workouts

      const now = new Date().toISOString();

      // Use Drizzle's batch API to insert each row as a separate statement
      // This avoids D1's SQL variable limit while keeping everything in one transaction
      const insertStatements = data.map((e) =>
        db.insert(workoutExercises).values({
          id: e.id,
          workoutId: e.workoutId,
          exerciseId: e.exerciseId,
          sets: e.sets,
          targetReps: e.targetReps,
          weight: e.weight ?? null,
          sortOrder: e.sortOrder,
          createdAt: now,
          updatedAt: now,
        }),
      );

      if (insertStatements.length > 0) {
        const [first, ...rest] = insertStatements;
        await db.batch([first, ...rest]);
      }

      return { success: true };
    },
  );

// Update workout exercise schema
const updateWorkoutExerciseSchema = z.object({
  id: z.string(),
  sets: z.number().min(1).max(20).optional(),
  targetReps: z.number().min(1).max(100).optional(),
  weight: z.number().nullable().optional(),
  sortOrder: z.number().optional(),
});

type UpdateWorkoutExerciseInput = z.infer<typeof updateWorkoutExerciseSchema>;

// Batch update workout exercises
const batchUpdateWorkoutExercisesSchema = z.array(updateWorkoutExerciseSchema);

export const updateWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchUpdateWorkoutExercisesSchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateWorkoutExerciseInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      // Get all exercise IDs and verify ownership
      const exerciseIds = data.map((e) => e.id);
      const existingExercises = await db.query.workoutExercises.findMany({
        where: inArray(workoutExercises.id, exerciseIds),
        with: {
          workout: {
            with: { program: true },
          },
        },
      });

      // Build a map of exerciseId -> verified workoutId for defense-in-depth
      const authorizedExerciseWorkoutMap = new Map<string, string>();
      for (const e of existingExercises) {
        if (e.workout.program.userId === context.userId) {
          authorizedExerciseWorkoutMap.set(e.id, e.workoutId);
        }
      }

      for (const exercise of data) {
        if (!authorizedExerciseWorkoutMap.has(exercise.id)) {
          throw new Error("Exercise not found or not authorized");
        }
      }

      // Update each exercise
      // Defense-in-depth: include workoutId in WHERE clause to ensure the exercise
      // still belongs to the same workout we verified ownership for
      const now = new Date().toISOString();
      await Promise.all(
        data.map((exercise) => {
          const { id, ...updates } = exercise;
          const verifiedWorkoutId = authorizedExerciseWorkoutMap.get(id)!;
          return db
            .update(workoutExercises)
            .set({ ...updates, updatedAt: now })
            .where(
              and(
                eq(workoutExercises.id, id),
                eq(workoutExercises.workoutId, verifiedWorkoutId),
              ),
            );
        }),
      );

      return { success: true };
    },
  );

// Delete workout exercise schema
const deleteWorkoutExerciseSchema = z.object({ id: z.string() });

type DeleteWorkoutExerciseInput = z.infer<typeof deleteWorkoutExerciseSchema>;

// Batch delete workout exercises
const batchDeleteWorkoutExercisesSchema = z.array(deleteWorkoutExerciseSchema);

export const deleteWorkoutExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    batchDeleteWorkoutExercisesSchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: DeleteWorkoutExerciseInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      const exerciseIds = data.map((e) => e.id);

      // Verify ownership
      const existingExercises = await db.query.workoutExercises.findMany({
        where: inArray(workoutExercises.id, exerciseIds),
        with: {
          workout: {
            with: { program: true },
          },
        },
      });

      const authorizedExerciseIds = existingExercises
        .filter((e) => e.workout.program.userId === context.userId)
        .map((e) => e.id);

      if (authorizedExerciseIds.length !== exerciseIds.length) {
        throw new Error("Exercise not found or not authorized");
      }

      await db
        .delete(workoutExercises)
        .where(inArray(workoutExercises.id, authorizedExerciseIds));

      return { success: true };
    },
  );
