import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db";
import { workouts, programs, workoutExercises } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  ensureUserMiddleware,
  type AuthenticatedContext,
} from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";

// Get all workouts for user's programs
export const getAllWorkouts = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const result = await db
      .select({ workout: workouts })
      .from(workouts)
      .innerJoin(programs, eq(workouts.programId, programs.id))
      .where(eq(programs.userId, context.userId));

    return { workouts: result.map((r) => r.workout) };
  });

// Create workout
const createWorkoutSchema = z.object({
  id: z.string(),
  programId: z.string(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  sortOrder: z.number(),
});

export type CreateWorkoutInput = z.infer<typeof createWorkoutSchema>;

// Batch create workouts
const batchCreateWorkoutsSchema = z.array(createWorkoutSchema);

export const createWorkouts = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => batchCreateWorkoutsSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateWorkoutInput[];
      context: AuthenticatedContext;
    }) => {
      if (data.length === 0) {
        return { success: true };
      }

      // Get unique program IDs and verify ownership
      const programIds = [...new Set(data.map((w) => w.programId))];
      const userPrograms = await db.query.programs.findMany({
        where: and(
          inArray(programs.id, programIds),
          eq(programs.userId, context.userId),
        ),
      });

      const authorizedProgramIds = new Set(userPrograms.map((p) => p.id));
      for (const workout of data) {
        if (!authorizedProgramIds.has(workout.programId)) {
          throw new Error("Program not found or not authorized");
        }
      }

      const now = new Date().toISOString();

      // Use Drizzle's batch API to insert each row as a separate statement
      // This avoids D1's SQL variable limit while keeping everything in one transaction
      const insertStatements = data.map((w) =>
        db.insert(workouts).values({
          id: w.id,
          programId: w.programId,
          name: w.name,
          description: w.description ?? null,
          sortOrder: w.sortOrder,
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

// Update workout
const updateWorkoutSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  sortOrder: z.number().optional(),
});

export type UpdateWorkoutInput = z.infer<typeof updateWorkoutSchema>;

export const updateWorkout = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateWorkoutSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateWorkoutInput;
      context: AuthenticatedContext;
    }) => {
      // Verify ownership through program
      const workout = await db.query.workouts.findFirst({
        where: eq(workouts.id, data.id),
        with: { program: true },
      });

      if (!workout || workout.program.userId !== context.userId) {
        throw new Error("Workout not found or not authorized");
      }

      const { id, ...updates } = data;
      await db
        .update(workouts)
        .set({ ...updates, updatedAt: new Date().toISOString() })
        .where(eq(workouts.id, id));

      return { success: true };
    },
  );

// Delete workout
export const deleteWorkout = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: { id: string };
      context: AuthenticatedContext;
    }) => {
      const workout = await db.query.workouts.findFirst({
        where: eq(workouts.id, data.id),
        with: { program: true },
      });

      if (!workout || workout.program.userId !== context.userId) {
        throw new Error("Workout not found or not authorized");
      }

      await db.delete(workouts).where(eq(workouts.id, data.id));
      return { success: true };
    },
  );

// Delete workout with all its exercises (atomic cascade delete)
const deleteWorkoutWithExercisesSchema = z.object({
  workoutId: z.string(),
  exerciseIds: z.array(z.string()),
});

type DeleteWorkoutWithExercisesInput = z.infer<
  typeof deleteWorkoutWithExercisesSchema
>;

export const deleteWorkoutWithExercises = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    deleteWorkoutWithExercisesSchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: DeleteWorkoutWithExercisesInput;
      context: AuthenticatedContext;
    }) => {
      // Verify workout ownership
      const workout = await db.query.workouts.findFirst({
        where: eq(workouts.id, data.workoutId),
        with: { program: true },
      });

      if (!workout || workout.program.userId !== context.userId) {
        throw new Error("Workout not found or not authorized");
      }

      // Delete exercises first (FK constraint), then delete workout
      // Using batch for atomicity
      const deleteWorkoutStmt = db
        .delete(workouts)
        .where(eq(workouts.id, data.workoutId));

      if (data.exerciseIds.length > 0) {
        const deleteExercisesStmt = db
          .delete(workoutExercises)
          .where(inArray(workoutExercises.id, data.exerciseIds));

        await db.batch([deleteExercisesStmt, deleteWorkoutStmt]);
      } else {
        await deleteWorkoutStmt;
      }

      return { success: true };
    },
  );
