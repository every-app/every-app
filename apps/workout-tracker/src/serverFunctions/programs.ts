import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "@/db";
import {
  programs,
  workouts,
  exerciseLibrary,
  workoutExercises,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  ensureUserMiddleware,
  type AuthenticatedContext,
} from "@/middleware/ensureUser";
import { useSessionTokenClientMiddleware } from "@/embedded-sdk/client";

// List all user programs with their workouts and exercises
export const getAllPrograms = createServerFn()
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .handler(async ({ context }: { context: AuthenticatedContext }) => {
    const userPrograms = await db.query.programs.findMany({
      where: eq(programs.userId, context.userId),
      with: {
        workouts: {
          orderBy: (workouts, { asc }) => [asc(workouts.sortOrder)],
          with: {
            workoutExercises: {
              orderBy: (workoutExercises, { asc }) => [
                asc(workoutExercises.sortOrder),
              ],
              with: {
                exercise: true, // Include the exercise library item for name
              },
            },
          },
        },
      },
    });

    return { programs: userPrograms };
  });

// Create a new program
const createProgramSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  templateId: z.string().optional(),
  isActive: z.boolean().default(false),
  currentWorkoutIndex: z.number().default(0),
});

export type CreateProgramInput = z.infer<typeof createProgramSchema>;

export const createProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => createProgramSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateProgramInput;
      context: AuthenticatedContext;
    }) => {
      const now = new Date().toISOString();
      await db.insert(programs).values({
        ...data,
        userId: context.userId,
        createdAt: now,
        updatedAt: now,
      });

      return { success: true };
    },
  );

// Update program
const updateProgramSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional(),
  currentWorkoutIndex: z.number().optional(),
});

export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;

export const updateProgram = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) => updateProgramSchema.parse(data))
  .handler(
    async ({
      data,
      context,
    }: {
      data: UpdateProgramInput;
      context: AuthenticatedContext;
    }) => {
      const program = await db.query.programs.findFirst({
        where: and(
          eq(programs.id, data.id),
          eq(programs.userId, context.userId),
        ),
      });

      if (!program) {
        throw new Error("Program not found");
      }

      const { id, ...updates } = data;

      // If setting active, deactivate all other programs first
      if (updates.isActive === true) {
        await db
          .update(programs)
          .set({ isActive: false, updatedAt: new Date().toISOString() })
          .where(eq(programs.userId, context.userId));
      }

      // Defense-in-depth: include userId in WHERE clause
      await db
        .update(programs)
        .set({ ...updates, updatedAt: new Date().toISOString() })
        .where(and(eq(programs.id, id), eq(programs.userId, context.userId)));

      return { success: true };
    },
  );

// Delete program
export const deleteProgram = createServerFn({ method: "POST" })
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
      const program = await db.query.programs.findFirst({
        where: and(
          eq(programs.id, data.id),
          eq(programs.userId, context.userId),
        ),
      });

      if (!program) {
        throw new Error("Program not found");
      }

      // Defense-in-depth: include userId in WHERE clause
      await db
        .delete(programs)
        .where(
          and(eq(programs.id, data.id), eq(programs.userId, context.userId)),
        );
      return { success: true };
    },
  );

// Create program from template (atomically creates program, workouts, exercises)
const exerciseTemplateSchema = z.object({
  name: z.string(),
  sets: z.number(),
  targetReps: z.number(),
  weight: z.number().optional(),
});

const workoutTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  exercises: z.array(
    exerciseTemplateSchema.extend({
      id: z.string(),
      exerciseLibraryId: z.string(),
    }),
  ),
});

const createProgramFromTemplateSchema = z.object({
  program: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    difficulty: z.enum(["beginner", "intermediate", "advanced"]),
    templateId: z.string().optional(),
  }),
  exerciseLibraryItems: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  workouts: z.array(workoutTemplateSchema),
});

type CreateProgramFromTemplateInput = z.infer<
  typeof createProgramFromTemplateSchema
>;

export const createProgramFromTemplate = createServerFn({ method: "POST" })
  .middleware([useSessionTokenClientMiddleware, ensureUserMiddleware])
  .inputValidator((data: unknown) =>
    createProgramFromTemplateSchema.parse(data),
  )
  .handler(
    async ({
      data,
      context,
    }: {
      data: CreateProgramFromTemplateInput;
      context: AuthenticatedContext;
    }) => {
      const now = new Date().toISOString();

      // Build all insert statements to run in a single batch
      // This avoids D1's SQL variable limit (100 params) while keeping everything in one transaction

      // Create program insert statement
      const programStatement = db.insert(programs).values({
        id: data.program.id,
        userId: context.userId,
        name: data.program.name,
        description: data.program.description,
        difficulty: data.program.difficulty,
        templateId: data.program.templateId ?? null,
        currentWorkoutIndex: 0,
        isActive: false,
        createdAt: now,
        updatedAt: now,
      });

      // Create exercise library insert statements
      const exerciseLibraryStatements = data.exerciseLibraryItems.map((item) =>
        db.insert(exerciseLibrary).values({
          id: item.id,
          userId: context.userId,
          name: item.name,
          notes: null,
          createdAt: now,
          updatedAt: now,
        }),
      );

      // Create workout insert statements
      const workoutStatements = data.workouts.map((workout, index) =>
        db.insert(workouts).values({
          id: workout.id,
          programId: data.program.id,
          name: workout.name,
          description: workout.description ?? null,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        }),
      );

      // Create workout exercise insert statements
      const workoutExerciseStatements = data.workouts.flatMap((workout) =>
        workout.exercises.map((exercise, index) =>
          db.insert(workoutExercises).values({
            id: exercise.id,
            workoutId: workout.id,
            exerciseId: exercise.exerciseLibraryId,
            sets: exercise.sets,
            targetReps: exercise.targetReps,
            weight: exercise.weight ?? null,
            sortOrder: index,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      );

      // Execute all statements in a single batch transaction
      // Program must be first, followed by exercise library (for FK constraint),
      // then workouts, then workout exercises
      await db.batch([
        programStatement,
        ...exerciseLibraryStatements,
        ...workoutStatements,
        ...workoutExerciseStatements,
      ]);

      return { success: true };
    },
  );
