import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
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
  createCustomProgramSchema,
  createProgramFromTemplateSchema,
  createProgramSchema,
  updateProgramSchema,
} from "@/types/schemas/programs";

export const getAllPrograms = createServerFn()
  .middleware([ensureUserMiddleware])
  .handler(async ({ context }) => {
    const userPrograms = await db.query.programs.findMany({
      where: eq(programs.userId, context.userId),
    });

    return { programs: userPrograms };
  });

export const createProgram = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    await db.insert(programs).values({
      id: data.id,
      userId: context.userId,
      name: data.name,
      description: data.description,
      difficulty: data.difficulty,
      templateId: data.templateId ?? null,
      isActive: data.isActive,
      currentWorkoutIndex: data.currentWorkoutIndex,
      createdAt: now,
      updatedAt: now,
    });

    return { success: true };
  });

export const updateProgram = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => updateProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.programs.findFirst({
      where: and(eq(programs.id, data.id), eq(programs.userId, context.userId)),
    });
    if (!existing) throw new Error("Program not found");

    const { id, ...updates } = data;
    const now = new Date().toISOString();
    if (updates.isActive === true) {
      await db
        .update(programs)
        .set({ isActive: false, updatedAt: now })
        .where(eq(programs.userId, context.userId));
    }
    await db
      .update(programs)
      .set({ ...updates, updatedAt: now })
      .where(and(eq(programs.id, id), eq(programs.userId, context.userId)));

    return { success: true };
  });

export const deleteProgram = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => z.object({ id: z.string() }).parse(data))
  .handler(async ({ data, context }) => {
    const existing = await db.query.programs.findFirst({
      where: and(eq(programs.id, data.id), eq(programs.userId, context.userId)),
    });
    if (!existing) throw new Error("Program not found");

    await db
      .delete(programs)
      .where(
        and(eq(programs.id, data.id), eq(programs.userId, context.userId)),
      );

    return { success: true };
  });

export const createProgramFromTemplate = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    createProgramFromTemplateSchema.parse(data),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();

    if (data.program.isActive) {
      await db
        .update(programs)
        .set({ isActive: false, updatedAt: now })
        .where(eq(programs.userId, context.userId));
    }

    const programStatement = db.insert(programs).values({
      id: data.program.id,
      userId: context.userId,
      name: data.program.name,
      description: data.program.description,
      difficulty: data.program.difficulty,
      templateId: data.program.templateId ?? null,
      currentWorkoutIndex: 0,
      isActive: data.program.isActive,
      createdAt: now,
      updatedAt: now,
    });
    const libraryStatements = data.exerciseLibraryItems.map((item) =>
      db.insert(exerciseLibrary).values({
        id: item.id,
        userId: context.userId,
        name: item.name,
        notes: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const workoutStatements = data.workouts.map((workout, sortOrder) =>
      db.insert(workouts).values({
        id: workout.id,
        programId: data.program.id,
        name: workout.name,
        description: workout.description ?? null,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const exerciseStatements = data.workouts.flatMap((workout) =>
      workout.exercises.map((exercise, sortOrder) =>
        db.insert(workoutExercises).values({
          id: exercise.id,
          workoutId: workout.id,
          exerciseId: exercise.exerciseLibraryId,
          sets: exercise.sets,
          targetReps: exercise.targetReps,
          weight: exercise.weight ?? null,
          sortOrder,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    );

    // Keep FK-safe ordering and execute the complete tree as one D1 batch.
    await db.batch([
      programStatement,
      ...libraryStatements,
      ...workoutStatements,
      ...exerciseStatements,
    ]);

    return { success: true };
  });

export const createCustomProgram = createServerFn({ method: "POST" })
  .middleware([ensureUserMiddleware])
  .inputValidator((data: unknown) => createCustomProgramSchema.parse(data))
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    await db.batch([
      db.insert(programs).values({
        id: data.programId,
        userId: context.userId,
        name: "My Custom Program",
        description: "",
        difficulty: "n/a",
        templateId: null,
        currentWorkoutIndex: 0,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(workouts).values({
        id: data.workoutId,
        programId: data.programId,
        name: "Workout 1",
        description: null,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      }),
    ]);

    return { success: true };
  });
