import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  exerciseLibrary,
  programs,
  workoutExercises,
  workouts,
} from "@/db/schema";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  batchCreateWorkoutsSchema,
  deleteWorkoutWithExercisesSchema,
  saveWorkoutEditsSchema,
  updateWorkoutSchema,
} from "@/types/schemas/workouts";

export const getAllWorkouts = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const result = await db
      .select({ workout: workouts })
      .from(workouts)
      .innerJoin(programs, eq(workouts.programId, programs.id))
      .where(eq(programs.userId, context.userId));

    return { workouts: result.map(({ workout }) => workout) };
  });

export const createWorkouts = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => batchCreateWorkoutsSchema.parse(data))
  .handler(async ({ data, context }) => {
    if (data.length === 0) return { success: true };

    const programIds = [...new Set(data.map((workout) => workout.programId))];
    const ownedPrograms = await db.query.programs.findMany({
      where: and(
        inArray(programs.id, programIds),
        eq(programs.userId, context.userId),
      ),
    });
    const authorizedIds = new Set(ownedPrograms.map((program) => program.id));
    if (data.some((workout) => !authorizedIds.has(workout.programId))) {
      throw new Error("Program not found or not authorized");
    }

    const now = new Date().toISOString();
    const statements = data.map((workout) =>
      db.insert(workouts).values({
        id: workout.id,
        programId: workout.programId,
        name: workout.name,
        description: workout.description ?? null,
        sortOrder: workout.sortOrder,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const [first, ...rest] = statements;
    await db.batch([first, ...rest]);

    return { success: true };
  });

export const updateWorkout = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateWorkoutSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.workouts.findFirst({
      where: eq(workouts.id, data.id),
      with: { program: true },
    });
    if (!existing || existing.program.userId !== context.userId) {
      throw new Error("Workout not found or not authorized");
    }

    const { id, ...updates } = data;
    await db
      .update(workouts)
      .set({ ...updates, updatedAt: new Date().toISOString() })
      .where(
        and(eq(workouts.id, id), eq(workouts.programId, existing.programId)),
      );

    return { success: true };
  });

export const saveWorkoutEdits = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => saveWorkoutEditsSchema.parse(data))
  .handler(async ({ data, context }) => {
    const ownedWorkout = await db
      .select({ id: workouts.id, programId: workouts.programId })
      .from(workouts)
      .innerJoin(programs, eq(workouts.programId, programs.id))
      .where(
        and(
          eq(workouts.id, data.workout.id),
          eq(programs.userId, context.userId),
        ),
      )
      .get();
    if (!ownedWorkout) {
      throw new Error("Workout not found or not authorized");
    }

    const createWorkoutIds = [
      ...new Set(data.create.map((item) => item.workoutId)),
    ];
    if (createWorkoutIds.length > 0) {
      const ownedWorkouts = await db
        .select({ id: workouts.id })
        .from(workouts)
        .innerJoin(programs, eq(workouts.programId, programs.id))
        .where(
          and(
            inArray(workouts.id, createWorkoutIds),
            eq(programs.userId, context.userId),
          ),
        );
      const authorizedIds = new Set(ownedWorkouts.map((workout) => workout.id));
      if (data.create.some((item) => !authorizedIds.has(item.workoutId))) {
        throw new Error("Workout not found or not authorized");
      }
    }

    const workoutExerciseIds = [
      ...new Set([
        ...data.update.map((item) => item.id),
        ...data.remove.map((item) => item.id),
      ]),
    ];
    const authorizedWorkoutByExercise = new Map<string, string>();
    if (workoutExerciseIds.length > 0) {
      const existingExercises = await db.query.workoutExercises.findMany({
        where: inArray(workoutExercises.id, workoutExerciseIds),
        with: { workout: { with: { program: true } } },
      });
      for (const exercise of existingExercises) {
        if (exercise.workout.program.userId === context.userId) {
          authorizedWorkoutByExercise.set(exercise.id, exercise.workoutId);
        }
      }
      if (
        workoutExerciseIds.some((id) => !authorizedWorkoutByExercise.has(id))
      ) {
        throw new Error("Exercise not found or not authorized");
      }
    }

    const libraryIds = [...new Set(data.libraryUpdates.map((item) => item.id))];
    if (libraryIds.length > 0) {
      const existingLibraryItems = await db.query.exerciseLibrary.findMany({
        where: and(
          inArray(exerciseLibrary.id, libraryIds),
          eq(exerciseLibrary.userId, context.userId),
        ),
      });
      const authorizedIds = new Set(
        existingLibraryItems.map((item) => item.id),
      );
      if (libraryIds.some((id) => !authorizedIds.has(id))) {
        throw new Error("Exercise not found or not authorized");
      }
    }

    const now = new Date().toISOString();
    const deleteStatements = data.remove.map(({ id }) =>
      db
        .delete(workoutExercises)
        .where(
          and(
            eq(workoutExercises.id, id),
            eq(
              workoutExercises.workoutId,
              authorizedWorkoutByExercise.get(id)!,
            ),
          ),
        ),
    );
    const workoutStatement = db
      .update(workouts)
      .set({
        name: data.workout.name,
        description: data.workout.description,
        updatedAt: now,
      })
      .where(
        and(
          eq(workouts.id, data.workout.id),
          eq(workouts.programId, ownedWorkout.programId),
        ),
      );
    const exerciseUpdateStatements = data.update.map(({ id, ...updates }) =>
      db
        .update(workoutExercises)
        .set({ ...updates, updatedAt: now })
        .where(
          and(
            eq(workoutExercises.id, id),
            eq(
              workoutExercises.workoutId,
              authorizedWorkoutByExercise.get(id)!,
            ),
          ),
        ),
    );
    const libraryUpdateStatements = data.libraryUpdates.map(
      ({ id, progressionIncrement }) =>
        db
          .update(exerciseLibrary)
          .set({ progressionIncrement, updatedAt: now })
          .where(
            and(
              eq(exerciseLibrary.id, id),
              eq(exerciseLibrary.userId, context.userId),
            ),
          ),
    );
    const createStatements = data.create.map((item) =>
      db.insert(workoutExercises).values({
        id: item.id,
        workoutId: item.workoutId,
        exerciseId: item.exerciseId,
        sets: item.sets,
        targetReps: item.targetReps,
        weight: item.weight ?? null,
        sortOrder: item.sortOrder,
        createdAt: now,
        updatedAt: now,
      }),
    );

    // Delete first to clear conflicting rows; insert last after all parent updates.
    const statements = [
      ...deleteStatements,
      workoutStatement,
      ...exerciseUpdateStatements,
      ...libraryUpdateStatements,
      ...createStatements,
    ];
    const [first, ...rest] = statements;
    await db.batch([first, ...rest]);

    return { success: true };
  });

export const deleteWorkout = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.workouts.findFirst({
      where: eq(workouts.id, data.id),
      with: { program: true },
    });
    if (!existing || existing.program.userId !== context.userId) {
      throw new Error("Workout not found or not authorized");
    }

    await db
      .delete(workouts)
      .where(
        and(
          eq(workouts.id, data.id),
          eq(workouts.programId, existing.programId),
        ),
      );

    return { success: true };
  });

export const deleteWorkoutWithExercises = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    deleteWorkoutWithExercisesSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    const existing = await db.query.workouts.findFirst({
      where: eq(workouts.id, data.workoutId),
      with: { program: true },
    });
    if (!existing || existing.program.userId !== context.userId) {
      throw new Error("Workout not found or not authorized");
    }

    const deleteWorkoutStatement = db
      .delete(workouts)
      .where(
        and(
          eq(workouts.id, data.workoutId),
          eq(workouts.programId, existing.programId),
        ),
      );

    if (data.exerciseIds.length > 0) {
      await db.batch([
        db
          .delete(workoutExercises)
          .where(
            and(
              inArray(workoutExercises.id, data.exerciseIds),
              eq(workoutExercises.workoutId, data.workoutId),
            ),
          ),
        deleteWorkoutStatement,
      ]);
    } else {
      await deleteWorkoutStatement;
    }

    return { success: true };
  });
